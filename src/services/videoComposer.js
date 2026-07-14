// Builds and runs the ffmpeg filter_complex graph that turns a selected
// timeline (services/selection.js) into the final vertical recap, applying a
// randomly-chosen edit STYLE (services/styles.js): transitions + length,
// colour grade, gentle photo drift, hero-held close-ups, optional
// split-screen moments, and a bold Canva-style title block
// ("FESTIVAL RECAP" + event name/location) over the opening shot. Ends on the
// branded end card (services/endCard.js); the music track is the only audio.
import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { generateEndCard } from "./endCard.js";
import { getStyle } from "./styles.js";

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const TITLE_SECONDS = 3.2;

// Every segment MUST end identically formatted or xfade fails with "Error
// reinitializing filters / Failed to inject frame": same pixel format (the end
// card PNG is RGBA, video is YUV), frame rate, SAR, and timebase.
const NORM = "format=yuv420p,fps=30,setsar=1,settb=AVTB";

// One half of a split-screen: cover-crop a source into a width x height panel.
function panelFilter(sub, inputIndex, width, height, eq, outLabel) {
  if (sub.kind === "video") {
    return (
      `[${inputIndex}:v]trim=0:${sub.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},${eq}[${outLabel}]`
    );
  }
  return (
    `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},${eq}[${outLabel}]`
  );
}

function segmentFilter({ item, index, width, height, grade, panPx }) {
  const label = `v${index}`;
  const frames = Math.max(1, Math.round(item.duration * 30));
  const eq = `eq=saturation=${grade.saturation}:contrast=${grade.contrast}:brightness=${grade.brightness}`;

  // Split-screen moment: two clips stacked vertically (Canva-style geometry).
  if (item.kind === "split") {
    const half = height / 2;
    const pa = `p${index}a`;
    const pb = `p${index}b`;
    return {
      label,
      filter:
        panelFilter(item.a, item.a.inputIndex, width, half, eq, pa) +
        ";" +
        panelFilter(item.b, item.b.inputIndex, width, half, eq, pb) +
        `;[${pa}][${pb}]vstack=inputs=2,${NORM}[${label}]`,
    };
  }

  // 3-panel stacked split (beatcut structure): top/middle/bottom, the middle
  // panel carrying the hook shot while neighbours swap on the beat.
  if (item.kind === "split3") {
    const third = Math.floor(height / 3); // 640 for 1920
    const pa = `p${index}a`;
    const pb = `p${index}b`;
    const pc = `p${index}c`;
    return {
      label,
      filter:
        panelFilter(item.a, item.a.inputIndex, width, third, eq, pa) +
        ";" +
        panelFilter(item.b, item.b.inputIndex, width, third, eq, pb) +
        ";" +
        panelFilter(item.c, item.c.inputIndex, width, height - 2 * third, eq, pc) +
        `;[${pa}][${pb}][${pc}]vstack=inputs=3,${NORM}[${label}]`,
    };
  }

  // Branded end card: already width x height; give it a subtle slow zoom.
  if (item.kind === "card") {
    const zoomStep = (0.08 / frames).toFixed(6);
    return {
      label,
      filter:
        `[${item.inputIndex}:v]scale=${width}:${height},` +
        `zoompan=z='min(zoom+${zoomStep},1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
        `${NORM}[${label}]`,
    };
  }

  // Photo: gentle Ken Burns drift, Canva-style — the shot stays essentially
  // still and the CUTS carry the energy. The crop window starts centered and
  // drifts at most `panPx` pixels over the whole slice (clipped to the image so
  // it can never overrun, whatever the orientation/EXIF rotation).
  if (item.kind === "photo") {
    const coverW = Math.round(width * 1.08);
    const coverH = Math.round(height * 1.08);
    const dir = index % 2 === 0 ? 1 : -1;
    const xExpr = `clip((in_w-${width})/2 + ${dir * panPx}*(n/${frames}-0.5), 0, in_w-${width})`;
    return {
      label,
      filter:
        `[${item.inputIndex}:v]scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,${eq},` +
        `crop=${width}:${height}:x='${xExpr}':y='(in_h-${height})/2',` +
        `${NORM}[${label}]`,
    };
  }

  // Video clip: cover-crop to fill + colour lift.
  return {
    label,
    filter:
      `[${item.inputIndex}:v]trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
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

// Adds an input to the ffmpeg command for one media source and returns nothing;
// stills loop for the segment duration, videos seek to their scored window.
function addInput(command, sub, duration) {
  if (sub.kind === "video") {
    command
      .input(sub.storedPath)
      .inputOptions([`-ss ${(sub.trimStart ?? 0).toFixed(3)}`, `-t ${duration.toFixed(3)}`]);
  } else {
    command.input(sub.storedPath).inputOptions(["-loop 1", "-r 30", `-t ${duration.toFixed(3)}`]);
  }
}

export async function composeVideo({
  timeline,
  musicTrack,
  style: styleArg,
  eventName,
  titleSubText,
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
  let comp = timeline.map((it) => ({ ...it }));
  try {
    endCardPath = await generateEndCard({ eventName, width, height });
    const last = comp[comp.length - 1];
    comp[comp.length - 1] = { ...last, kind: "card", storedPath: endCardPath, trimStart: null };
  } catch {
    // keep the photo closing shot
  }

  const hardCuts = Boolean(style.hardCuts) || td <= 0;

  // xfade overlaps each cut by `td`, which would otherwise make the output
  // (n-1)*td shorter than target AND slide every cut off the beat grid — so
  // pad every segment after the first by one transition length. Hard-cut
  // styles concat instead: no overlap, no padding, cuts land exactly where
  // selection.js put them (on the beat).
  if (!hardCuts) {
    comp = comp.map((it, i) => {
      if (i === 0) return it;
      const padded = { ...it, duration: it.duration + td };
      for (const k of ["a", "b", "c"]) {
        if (it[k]) padded[k] = { ...it[k], duration: it[k].duration + td };
      }
      return padded;
    });
  }

  // Assign ffmpeg input indices (split moments consume 2-3 inputs).
  let inputIdx = 0;
  for (const it of comp) {
    if (it.kind === "split" || it.kind === "split3") {
      it.a.inputIndex = inputIdx++;
      it.b.inputIndex = inputIdx++;
      if (it.kind === "split3") it.c.inputIndex = inputIdx++;
    } else {
      it.inputIndex = inputIdx++;
    }
  }
  const musicInputIndex = inputIdx;

  const segments = comp.map((item, index) =>
    segmentFilter({ item, index, width, height, grade: style.grade, panPx: style.panPx ?? 50 }),
  );
  const durations = comp.map((item) => item.duration);

  let joinFilters;
  let totalDuration;
  if (hardCuts) {
    // Instant beat-synced cuts: plain concat of the normalized segments.
    const labels = segments.map((s) => `[${s.label}]`).join("");
    joinFilters = [`${labels}concat=n=${segments.length}:v=1:a=0[vmain]`];
    totalDuration = durations.reduce((s, d) => s + d, 0);
  } else {
    const chain = xfadeChain(segments.map((s) => s.label), durations, style.transitions, td);
    joinFilters = chain.filters;
    totalDuration = chain.totalDuration;
  }

  // Canva-style title block over the opening shot: huge bold "FESTIVAL RECAP",
  // with the event name + location beneath it.
  const mainPath = await writeTextFile("FESTIVAL RECAP");
  const subPath = await writeTextFile(titleSubText || eventName || "");
  const subY = `h*0.09+${style.titleMainSize + 34}`;
  const textFilters = [
    `[vmain]drawtext=textfile='${mainPath}':fontfile='${FONT_FILE}':fontsize=${style.titleMainSize}:fontcolor=white:` +
      `borderw=4:bordercolor=black@0.65:x=(w-text_w)/2:y=h*0.09:enable='between(t,0,${TITLE_SECONDS})'[vt1]`,
    `[vt1]drawtext=textfile='${subPath}':fontfile='${FONT_FILE}':fontsize=${style.titleSubSize}:fontcolor=white:` +
      `borderw=3:bordercolor=black@0.65:line_spacing=10:x=(w-text_w)/2:y=${subY}:enable='between(t,0,${TITLE_SECONDS})'[vout]`,
  ];

  // Long fade-out over the last ~2.5s so the music swells down through the end
  // card (dramatic lead-in to the evestival.com CTA).
  const fadeOut = Math.min(2.5, totalDuration / 2);
  const audioFilter =
    `[${musicInputIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=0.4,afade=t=out:st=${(totalDuration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`;

  const filterGraph = [...segments.map((s) => s.filter), ...joinFilters, ...textFilters, audioFilter].join(";");

  const command = ffmpeg();
  for (const item of comp) {
    if (item.kind === "split" || item.kind === "split3") {
      addInput(command, item.a, item.duration);
      addInput(command, item.b, item.duration);
      if (item.kind === "split3") addInput(command, item.c, item.duration);
    } else {
      addInput(command, item, item.duration);
    }
  }
  command.input(musicTrack.file_path);

  logger.info(
    {
      style: style.name,
      segments: comp.map((it, i) => ({ i, kind: it.kind, dur: Number(it.duration.toFixed(2)) })),
      musicIndex: musicInputIndex,
      totalDuration: Number(totalDuration.toFixed(2)),
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
      unlink(mainPath).catch(() => {}),
      unlink(subPath).catch(() => {}),
      endCardPath ? unlink(endCardPath).catch(() => {}) : Promise.resolve(),
    ]);
  }

  return { outputPath, totalDuration };
}
