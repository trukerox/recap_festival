// Builds and runs the ffmpeg filter_complex graph that turns a selected
// timeline (see services/selection.js) into the final 20s 1080x1920 recap:
// Ken Burns pan/zoom on photos, xfade transitions between every segment,
// color/vibrance grading, title + CTA text cards, an optional logo
// watermark, and the chosen music track mixed in as the only audio.
import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";

const TRANSITION_DURATION = 0.35;
const TRANSITIONS = ["fade", "wipeleft", "slideup", "circleopen", "wiperight", "slideleft"];
const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function segmentFilter({ item, index, width, height }) {
  const label = `v${index}`;
  if (item.kind === "photo") {
    // Alternate pan direction per segment for visual variety; zoom is capped
    // at 1.2x over the segment so it never overshoots and reveals padding.
    const panSign = index % 2 === 0 ? 1 : -1;
    const totalFrames = Math.max(1, Math.round(item.duration * 30));
    const zoomStep = (0.2 / totalFrames).toFixed(6);
    const filter =
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `zoompan=z='min(zoom+${zoomStep},1.2)':` +
      `x='iw/2-(iw/zoom/2)+on*${(panSign * 0.4).toFixed(2)}':` +
      `y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
      `setsar=1[${label}]`;
    return { label, filter };
  }

  const filter =
    `[${index}:v]trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `eq=saturation=1.25:contrast=1.05:brightness=0.02,` +
    `fps=30,setsar=1[${label}]`;
  return { label, filter };
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
  watermarkPath,
  titleText,
  ctaText,
  outputPath,
  onProgress,
}) {
  const width = config.render.width;
  const height = config.render.height;

  const segments = timeline.map((item, index) => segmentFilter({ item, index, width, height }));
  const durations = timeline.map((item) => item.duration);
  const { filters: xfadeFilters, totalDuration } = xfadeChain(
    segments.map((s) => s.label),
    durations,
  );

  const titlePath = await writeTextFile(titleText);
  const ctaPath = await writeTextFile(ctaText);
  const ctaStart = Math.max(0, totalDuration - 3);

  const watermarkInputIndex = timeline.length; // added right after media inputs
  const musicInputIndex = watermarkPath ? watermarkInputIndex + 1 : watermarkInputIndex;

  const textFilters = [
    `[vmain]drawtext=textfile='${titlePath}':fontfile='${FONT_FILE}':fontsize=64:fontcolor=white:` +
      `borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.12:enable='between(t,0,3)'[vtitle]`,
    `[vtitle]drawtext=textfile='${ctaPath}':fontfile='${FONT_FILE}':fontsize=48:fontcolor=white:` +
      `borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.8:line_spacing=10:` +
      `enable='between(t,${ctaStart.toFixed(3)},${totalDuration.toFixed(3)})'[vcta]`,
  ];

  let videoOutLabel = "vcta";
  const watermarkFilters = [];
  if (watermarkPath) {
    watermarkFilters.push(
      `[${watermarkInputIndex}:v]scale=180:-1[wm]`,
      `[vcta][wm]overlay=W-200:H-220:enable='between(t,0,${totalDuration.toFixed(3)})'[vwm]`,
    );
    videoOutLabel = "vwm";
  }

  const audioFilter =
    `[${musicInputIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=0.4,afade=t=out:st=${(totalDuration - 0.6).toFixed(3)}:d=0.6[aout]`;

  const filterGraph = [
    ...segments.map((s) => s.filter),
    ...xfadeFilters,
    ...textFilters,
    ...watermarkFilters,
    audioFilter,
  ].join(";");

  const command = ffmpeg();

  for (const item of timeline) {
    if (item.kind === "photo") {
      command.input(item.storedPath).inputOptions(["-loop 1", "-r 30", `-t ${item.duration.toFixed(3)}`]);
    } else {
      command
        .input(item.storedPath)
        .inputOptions([`-ss ${(item.trimStart ?? 0).toFixed(3)}`, `-t ${item.duration.toFixed(3)}`]);
    }
  }
  if (watermarkPath) command.input(watermarkPath);
  command.input(musicTrack.file_path);

  try {
    await new Promise((resolve, reject) => {
      // NB: don't pass the output map as complexFilter's 2nd arg AND also add
      // -map below — that double-maps and ffmpeg errors. We map explicitly via
      // outputOptions, so complexFilter takes only the graph string.
      command
        .complexFilter(filterGraph)
        .outputOptions([
          "-map", `[${videoOutLabel}]`,
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
    await Promise.all([unlink(titlePath).catch(() => {}), unlink(ctaPath).catch(() => {})]);
  }

  return { outputPath, totalDuration };
}
