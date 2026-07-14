// Builds and runs the ffmpeg filter_complex graph that turns a selected
// timeline (see services/selection.js) into the final 20s 1080x1920 recap:
// Ken Burns motion on photos (horizontal pan across landscape shots, zoom on
// portrait), xfade transitions between every segment, color grading, an
// opening title, a professional branded end card (services/endCard.js), and
// the chosen music track as the only audio. No floating watermark.
import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import { generateEndCard } from "./endCard.js";

const TRANSITION_DURATION = 0.35;
const TRANSITIONS = ["fade", "wipeleft", "slideup", "circleopen", "wiperight", "slideleft"];
const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// A source is "wide" (pan it) when it's wider than the 9:16 target aspect —
// true for almost every non-portrait photo. Portrait shots fall through to the
// fill-zoom branch instead.
function isWide(item, width, height) {
  return item.srcWidth && item.srcHeight && item.srcWidth / item.srcHeight > width / height;
}

// Every segment MUST end identically formatted or xfade fails with "Error
// reinitializing filters / Failed to inject frame": same pixel format (the end
// card PNG is RGBA, video is YUV — the #1 cause here), frame rate, SAR, and
// timebase. This suffix normalizes all of them.
const NORM = "format=yuv420p,fps=30,setsar=1,settb=AVTB";

function segmentFilter({ item, index, width, height }) {
  const label = `v${index}`;
  const frames = Math.max(1, Math.round(item.duration * 30));

  // Branded end card: already width x height; give it a subtle slow zoom.
  if (item.kind === "card") {
    const zoomStep = (0.08 / frames).toFixed(6);
    return {
      label,
      filter:
        `[${index}:v]scale=${width}:${height},` +
        `zoompan=z='min(zoom+${zoomStep},1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
        `${NORM}[${label}]`,
    };
  }

  // Landscape photo: horizontal Ken Burns pan across the FULL width. Scale to
  // the frame height, then slide a 9:16 crop window left→right (or right→left
  // on odd segments) so the whole scene is revealed instead of centre-cropped.
  if (item.kind === "photo" && isWide(item, width, height)) {
    const dir = index % 2 === 0 ? `n/${frames}` : `(1-n/${frames})`;
    return {
      label,
      filter:
        `[${index}:v]scale=-2:${height},eq=saturation=1.2:contrast=1.04,` +
        `crop=${width}:${height}:x='(in_w-${width})*${dir}':y=0,${NORM}[${label}]`,
    };
  }

  // Portrait/square photo: fill the frame and slow-zoom (classic Ken Burns).
  if (item.kind === "photo") {
    const zoomStep = (0.2 / frames).toFixed(6);
    return {
      label,
      filter:
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `zoompan=z='min(zoom+${zoomStep},1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
        `eq=saturation=1.2:contrast=1.04,${NORM}[${label}]`,
    };
  }

  // Video clip: cover-crop to fill + colour lift.
  return {
    label,
    filter:
      `[${index}:v]trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `eq=saturation=1.25:contrast=1.05:brightness=0.02,${NORM}[${label}]`,
  };
}

function xfadeChain(segmentLabels, durations) {
  const filters = [];
  let cumulative = durations[0];
  let prevLabel = segmentLabels[0];

  for (let i = 1; i < segmentLabels.length; i++) {
    const outLabel = i === segmentLabels.length - 1 ? "vmain" : `x${i}`;
    const transition = TRANSITIONS[(i - 1) % TRANSITIONS.length];
    const offset = Math.max(0, cumulative - TRANSITION_DURATION);
    filters.push(
      `[${prevLabel}][${segmentLabels[i]}]xfade=transition=${transition}:duration=${TRANSITION_DURATION}:offset=${offset.toFixed(3)}[${outLabel}]`,
    );
    cumulative += durations[i] - TRANSITION_DURATION;
    prevLabel = outLabel;
  }
  return { filters, totalDuration: cumulative };
}

async function writeTextFile(text) {
  const path = join(config.paths.tmpDir, `${randomUUID()}.txt`);
  await writeFile(path, text, "utf8");
  return path;
}

export async function composeVideo({
  timeline,
  musicTrack,
  eventName,
  titleText,
  outputPath,
  onProgress,
}) {
  const width = config.render.width;
  const height = config.render.height;

  // Replace the final segment with the generated branded end card. If
  // rsvg-convert isn't available, fall back to the originally-selected closing
  // shot so a render still succeeds (just without the designed card).
  let endCardPath = null;
  let comp = timeline;
  try {
    endCardPath = await generateEndCard({ eventName, width, height });
    const lastIdx = timeline.length - 1;
    comp = timeline.map((it, i) => (i === lastIdx ? { ...it, kind: "card", storedPath: endCardPath, trimStart: null } : it));
  } catch {
    comp = timeline;
  }

  const segments = comp.map((item, index) => segmentFilter({ item, index, width, height }));
  const durations = comp.map((item) => item.duration);
  const { filters: xfadeFilters, totalDuration } = xfadeChain(
    segments.map((s) => s.label),
    durations,
  );

  const titlePath = await writeTextFile(titleText);
  const musicInputIndex = comp.length; // music is the input after all media

  // Opening title only (0-3s); the CTA now lives on the end card.
  const textFilters = [
    `[vmain]drawtext=textfile='${titlePath}':fontfile='${FONT_FILE}':fontsize=64:fontcolor=white:` +
      `borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.12:enable='between(t,0,3)'[vout]`,
  ];

  const audioFilter =
    `[${musicInputIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=0.4,afade=t=out:st=${(totalDuration - 0.6).toFixed(3)}:d=0.6[aout]`;

  const filterGraph = [...segments.map((s) => s.filter), ...xfadeFilters, ...textFilters, audioFilter].join(";");

  const command = ffmpeg();
  for (const item of comp) {
    if (item.kind === "photo" || item.kind === "card") {
      command.input(item.storedPath).inputOptions(["-loop 1", "-r 30", `-t ${item.duration.toFixed(3)}`]);
    } else {
      command
        .input(item.storedPath)
        .inputOptions([`-ss ${(item.trimStart ?? 0).toFixed(3)}`, `-t ${item.duration.toFixed(3)}`]);
    }
  }
  command.input(musicTrack.file_path);

  try {
    await new Promise((resolve, reject) => {
      // Map explicitly via outputOptions; don't also pass a map to
      // complexFilter or ffmpeg double-maps and errors.
      command
        .complexFilter(filterGraph)
        .outputOptions([
          "-map", "[vout]",
          "-map", "[aout]",
          "-c:v", "libx264",
          "-preset", config.render.ffmpegPreset,
          "-crf", "21",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          "-t", totalDuration.toFixed(3),
        ])
        .output(outputPath)
        .on("progress", (p) => onProgress?.(p))
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
  } finally {
    await Promise.all([
      unlink(titlePath).catch(() => {}),
      endCardPath ? unlink(endCardPath).catch(() => {}) : Promise.resolve(),
    ]);
  }

  return { outputPath, totalDuration };
}
