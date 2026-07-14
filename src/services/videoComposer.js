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

// Default entrance length: the move resolves over this many frames at the cut.
const PUNCH_FRAMES = 5;

// Entrance-move palette — the fix for "same transition all over". Each clip
// enters with a DIFFERENT eased move that resolves within a handful of frames
// (so the cut still lands ON the beat), giving per-cut variety without any
// cross-segment xfade (which would smear frames and slide cuts off the beat).
// Idea from burns' deterministic per-index variation (odd push in / even pull
// out), extended with directional slides. dz = extra zoom at the cut (decays);
// dx/dy = offset in output px at the cut (decays); pf = frames to resolve.
// Moves are deliberately gentle and settle over more frames — aggressive/short
// moves on every cut read as "too fast" (user feedback). pf = frames to resolve.
const ENTRANCE_MOVE = {
  none:     { dz: 0,     dx: 0,   dy: 0,   pf: PUNCH_FRAMES },
  punch:    { dz: 0.06,  dx: 0,   dy: 0,   pf: 8 },  // slam in, settle
  pullback: { dz: -0.05, dx: 0,   dy: 0,   pf: 9 },  // start wide, zoom to rest
  slideL:   { dz: 0.02,  dx: 80,  dy: 0,   pf: 10 }, // ease in from the right
  slideR:   { dz: 0.02,  dx: -80, dy: 0,   pf: 10 }, // ease in from the left
  slideU:   { dz: 0.02,  dx: 0,   dy: 80,  pf: 10 }, // push up
  slideD:   { dz: 0.02,  dx: 0,   dy: -80, pf: 10 }, // push down
};

// A no-adjacent-duplicate cycle; a random rotation per render keeps successive
// renders fresh too. Slides are softened to punch/pullback on real video (a
// directional slide of already-moving footage reads muddy).
const ENTRANCE_CYCLE = ["punch", "slideL", "pullback", "slideR", "punch", "slideU", "pullback", "slideD"];

// Assign one entrance per timeline segment. Only the energetic (hard-cut)
// styles get moves; the opening (under the title) and non-photo/video kinds
// stay still. Videos never slide — they get punch/pullback instead.
function assignEntrances(comp, hardCuts) {
  const start = Math.floor(Math.random() * ENTRANCE_CYCLE.length);
  const out = [];
  let p = 0;
  for (const it of comp) {
    const isMain = it.kind === "photo" || it.kind === "video";
    if (!hardCuts || !isMain || it.role === "opening" || it.kind === "card") {
      out.push("none");
      continue;
    }
    // Move on alternate cuts only — the rest are calm static holds (just the
    // gentle slow zoom), so the reel isn't in constant motion.
    if (p % 2 === 1) { out.push("none"); p++; continue; }
    let move = ENTRANCE_CYCLE[(start + p) % ENTRANCE_CYCLE.length];
    if (it.kind === "video" && move.startsWith("slide")) move = "punch"; // slides read muddy on moving footage
    out.push(move);
    p++;
  }
  return out;
}

// signed multiplier term, e.g. (0.1, "d") -> "+0.1*d", (-0.08, "d") -> "-0.08*d".
// Avoids emitting "+-x", which ffmpeg's expression parser dislikes.
function term(value, expr) {
  if (!value) return "";
  return `${value > 0 ? "+" : "-"}${Math.abs(value)}*${expr}`;
}

// Eased Ken Burns via zoompan (idea adapted from image-motion's eased camera,
// burns' deterministic per-index variation, and the beat-punch technique from
// Shorts editors):
//   * a slow zoom-in across the slice (slowZoom, fraction of baseZoom)
//   * smooth, BOUNDED horizontal drift using smoothstep, not a linear sweep
//     (linear full-width pans read "dizzy" — user complaint) — magnitude panPx
//   * an ENTRANCE move (see ENTRANCE_MOVE) whose zoom/offset decays over the
//     first few frames, so each cut lands ON the beat with a fresh feel.
// Pre-scaling the source to `scaleUp` kills the classic zoompan pixel jitter
// and leaves room to pan/zoom/slide without exposing black edges — zoompan also
// clamps x/y to valid range, so an aggressive slide safely rests at the edge.
function kenBurns({ inputIndex, frames, width, height, eq, scaleUp, baseZoom, slowZoom, panPx, dir, move, extra = "", label }) {
  const canW = Math.round(width * scaleUp);
  const canH = Math.round(height * scaleUp);
  const m = move || ENTRANCE_MOVE.none;
  const prog = `(on/${frames})`;
  const ease = `(${prog}*${prog}*(3-2*${prog}))`; // smoothstep 0->1
  const decay = `max(0,(${m.pf}-on))/${m.pf}`;    // 1 at the cut -> 0 after pf frames
  const z = `${baseZoom}${term(slowZoom, prog)}${term(m.dz, decay)}`;
  const x = `(iw-iw/zoom)/2${term(dir * panPx, `(${ease}-0.5)`)}${term(m.dx, decay)}`;
  const y = `(ih-ih/zoom)/2${term(m.dy, decay)}`;
  return (
    `[${inputIndex}:v]${extra}scale=${canW}:${canH}:force_original_aspect_ratio=increase,` +
    `crop=${canW}:${canH},${eq},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=30,` +
    `${NORM}[${label}]`
  );
}

function segmentFilter({ item, index, width, height, grade, panPx, entrance }) {
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

  const move = ENTRANCE_MOVE[entrance] ?? ENTRANCE_MOVE.none;

  // Photo: eased Ken Burns — a slow zoom-in + smooth bounded drift so the shot
  // feels alive (not the old mechanical linear sweep), plus a varied ENTRANCE
  // move (punch / pull-back / slide) that resolves on the beat, so no two cuts
  // feel the same. Larger scaleUp gives the slides room before zoompan clamps.
  if (item.kind === "photo") {
    const dir = index % 2 === 0 ? 1 : -1;
    return {
      label,
      filter: kenBurns({
        inputIndex: item.inputIndex, frames, width, height, eq,
        scaleUp: 1.25, baseZoom: 1.2, slowZoom: 0.035,
        panPx, dir, move, label,
      }),
    };
  }

  // Video clip: cover-crop to fill + colour lift. With no entrance move, keep
  // the cheap plain cover-crop; otherwise route through zoompan for the move.
  const trim = `trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,`;
  if (entrance === "none" || entrance == null) {
    return {
      label,
      filter:
        `[${item.inputIndex}:v]${trim}` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `${eq},${NORM}[${label}]`,
    };
  }
  return {
    label,
    filter: kenBurns({
      inputIndex: item.inputIndex, frames, width, height, eq,
      scaleUp: 1.18, baseZoom: 1.15, slowZoom: 0,
      panPx: 0, dir: 0, move, extra: trim, label,
    }),
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
  } catch (err) {
    // Keep the photo closing shot, but make the failure visible — a missing
    // branded card almost always means rsvg-convert/librsvg2-bin isn't in the
    // image (needs `update-pi.sh --force-rebuild`).
    logger.warn({ err: err.message }, "end card generation failed — falling back to closing shot (is librsvg2-bin installed? try --force-rebuild)");
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

  // Varied per-cut entrance moves on the hard-cut (energetic) styles so no two
  // cuts feel the same; the smooth cinematic style keeps its calm eased drift.
  const entrances = assignEntrances(comp, hardCuts);
  const segments = comp.map((item, index) =>
    segmentFilter({ item, index, width, height, grade: style.grade, panPx: style.panPx ?? 50, entrance: entrances[index] }),
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
