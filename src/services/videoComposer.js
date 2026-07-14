// Builds and runs the ffmpeg filter_complex graph that turns a selected
// timeline (services/selection.js) into the final vertical recap, applying a
// randomly-chosen edit STYLE (services/styles.js): its transitions, transition
// length, colour grade and title size. Ken Burns motion on photos, an opening
// title, a branded end card (services/endCard.js), and the chosen music track
// as the only audio. No floating watermark.
import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { generateEndCard } from "./endCard.js";
import { getStyle } from "./styles.js";

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Every segment MUST end identically formatted or xfade fails with "Error
// reinitializing filters / Failed to inject frame": same pixel format (the end
// card PNG is RGBA, video is YUV), frame rate, SAR, and timebase.
const NORM = "format=yuv420p,fps=30,setsar=1,settb=AVTB";

function segmentFilter({ item, index, width, height, grade }) {
  const label = `v${index}`;
  const frames = Math.max(1, Math.round(item.duration * 30));
  const eq = `eq=saturation=${grade.saturation}:contrast=${grade.contrast}:brightness=${grade.brightness}`;

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

  // Photo: Ken Burns pan. Cover-scale slightly larger than the frame (so the
  // crop input is always >= the frame and there's pan room on both axes), then
  // slide a 1080x1920 crop window. Adapts to any orientation / EXIF rotation.
  if (item.kind === "photo") {
    const coverW = Math.round(width * 1.12);
    const coverH = Math.round(height * 1.12);
    const p = index % 2 === 0 ? `n/${frames}` : `(1-n/${frames})`;
    return {
      label,
      filter:
        `[${index}:v]scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,${eq},` +
        `crop=${width}:${height}:x='(in_w-${width})*${p}':y='(in_h-${height})*${p}',` +
        `${NORM}[${label}]`,
    };
  }

  // Video clip: cover-crop to fill + colour lift.
  return {
    label,
    filter:
      `[${index}:v]trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `${eq},${NORM}[${label}]`,
  };
}

function xfadeChain(segmentLabels, durations, transitions, transitionDuration) {
  const filters = [];
  let cumulative = durations[0];
  let prevLabel = segmentLabels[0];

  for (let i = 1; i < segmentLabels.length; i++) {
    const outLabel = i === segmentLabels.length - 1 ? "vmain" : `x${i}`;
    const transition = transitions[(i - 1) % transitions.length];
    const offset = Math.max(0, cumulative - transitionDuration);
    filters.push(
      `[${prevLabel}][${segmentLabels[i]}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offset.toFixed(3)}[${outLabel}]`,
    );
    cumulative += durations[i] - transitionDuration;
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
  style: styleArg,
  eventName,
  titleText,
  outputPath,
  onProgress,
}) {
  const width = config.render.width;
  const height = config.render.height;
  const style = styleArg || getStyle(null);
  const td = style.transitionDuration;

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

  // Pad every segment after the first by one transition length. xfade overlaps
  // each cut by `td`, which would otherwise make the output (n-1)*td shorter
  // than target; adding it back makes the render hit its full nominal length.
  comp = comp.map((it, i) => (i === 0 ? it : { ...it, duration: it.duration + td }));

  const segments = comp.map((item, index) => segmentFilter({ item, index, width, height, grade: style.grade }));
  const durations = comp.map((item) => item.duration);
  const { filters: xfadeFilters, totalDuration } = xfadeChain(
    segments.map((s) => s.label),
    durations,
    style.transitions,
    td,
  );

  const titlePath = await writeTextFile(titleText);
  const musicInputIndex = comp.length; // music is the input after all media

  // Opening title only (0-3s); the CTA now lives on the end card.
  const textFilters = [
    `[vmain]drawtext=textfile='${titlePath}':fontfile='${FONT_FILE}':fontsize=${style.titleFontSize}:fontcolor=white:` +
      `borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.12:enable='between(t,0,3)'[vout]`,
  ];

  // Long fade-out over the last ~2.5s so the music swells down through the end
  // card (dramatic lead-in to the evestival.com CTA).
  const fadeOut = Math.min(2.5, totalDuration / 2);
  const audioFilter =
    `[${musicInputIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=0.4,afade=t=out:st=${(totalDuration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`;

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

  logger.info(
    {
      style: style.name,
      inputs: comp.map((it, i) => ({ i, kind: it.kind, dur: it.duration })),
      musicIndex: musicInputIndex,
      totalDuration,
    },
    "ffmpeg inputs",
  );

  try {
    await new Promise((resolve, reject) => {
      const stderrTail = [];
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
        .on("start", (cmd) => logger.info({ cmd }, "ffmpeg start"))
        .on("stderr", (line) => {
          stderrTail.push(line);
          if (stderrTail.length > 40) stderrTail.shift();
        })
        .on("progress", (p) => onProgress?.(p))
        .on("end", resolve)
        .on("error", (err) => {
          logger.error({ err: err.message, stderr: stderrTail.join("\n"), filterGraph }, "ffmpeg render failed");
          reject(err);
        })
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
