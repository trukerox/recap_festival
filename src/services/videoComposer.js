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

// Backdrop blur strength for the 9:16 conversion (see blurredFit). boxblur is
// cheap enough for the Pi; power=2 is two passes, which reads as a soft bokeh
// rather than a smear.
const BLUR_RADIUS = 20;

// Evestival brand orange — same value as the end card (services/endCard.js), so
// the title's event line and the closing CTA read as one brand.
const BRAND_ORANGE = "0xE07A1E";

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

// Blurred-background 9:16 conversion — the standard Shorts/Reels treatment for
// media that isn't already vertical. A cover-cropped, blurred, slightly darkened
// copy of the shot fills the frame, and the WHOLE shot is fitted on top, centred.
// Landscape photos previously lost ~68% of their width to the cover crop; now the
// whole scene is visible.
//
// Geometry: the bg covers the zoompan canvas (scaleUp x frame); the fg is fitted
// to the FINAL frame size and centred on that canvas. So at baseZoom (== scaleUp)
// zoompan shows exactly the fg's box — the shot is fully visible, and the slow
// zoom / entrance move only nibble its edges.
//
// Applied to EVERY photo on purpose: when a shot already fills 9:16 the fitted fg
// covers the frame and the blur is never seen. That avoids special-casing on
// orientation — which we can't trust anyway, since EXIF-rotated images report
// pre-rotation dimensions (sharp said 4000x1844 while ffmpeg auto-rotated to
// portrait, and that mismatch previously crashed the crop).
// No drift here: the shot is fitted, so sliding it around just looks like it's
// slipping. The slow zoom + entrance move carry the life.
function blurredFit({ inputIndex, index, frames, width, height, eq, scaleUp, baseZoom, slowZoom, move, label }) {
  const canW = Math.round(width * scaleUp);
  const canH = Math.round(height * scaleUp);
  const m = move || ENTRANCE_MOVE.none;
  const prog = `(on/${frames})`;
  const decay = `max(0,(${m.pf}-on))/${m.pf}`;
  const z = `${baseZoom}${term(slowZoom, prog)}${term(m.dz, decay)}`;
  const x = `(iw-iw/zoom)/2${term(m.dx, decay)}`;
  const y = `(ih-ih/zoom)/2${term(m.dy, decay)}`;
  const bg = `bg${index}`, fg = `fg${index}`, bgb = `bgb${index}`, fgs = `fgs${index}`;
  return (
    `[${inputIndex}:v]split=2[${bg}][${fg}];` +
    `[${bg}]scale=${canW}:${canH}:force_original_aspect_ratio=increase,crop=${canW}:${canH},` +
    `boxblur=luma_radius=${BLUR_RADIUS}:luma_power=2:chroma_radius=${BLUR_RADIUS}:chroma_power=1,` +
    `eq=brightness=-0.06[${bgb}];` + // darken the backdrop so the shot pops
    `[${fg}]scale=${width}:${height}:force_original_aspect_ratio=decrease[${fgs}];` +
    `[${bgb}][${fgs}]overlay=(W-w)/2:(H-h)/2,${eq},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=30,` +
    `${NORM}[${label}]`
  );
}

// Cohesive cinematic COLOUR grade applied to every photo/video clip (not the
// branded card). eq lift + a gentle teal-shadow / warm-highlight split-tone via
// curves — the "why does Canva look graded and ours looks like raw phone photos"
// layer. Colour-only here (order-independent, safe to run before zoompan); the
// spatial vignette is applied once to the finished frame instead. Kept moderate
// so it reads filmic, not like a heavy Instagram filter.
function gradeChain(grade) {
  // Teal-orange split-tone PARKED per user ("can wait") so transitions can be
  // judged cleanly. Re-enable by appending:
  //   + ",colorbalance=rs=-0.04:bs=0.12:rh=0.10:bh=-0.10"
  return `eq=saturation=${grade.saturation}:contrast=${grade.contrast}:brightness=${grade.brightness}`;
}

function segmentFilter({ item, index, width, height, grade, panPx, entrance }) {
  const label = `v${index}`;
  const frames = Math.max(1, Math.round(item.duration * 30));
  const eq = gradeChain(grade);

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
  // feel the same.
  // baseZoom MUST equal scaleUp so zoompan's window is exactly the frame — i.e.
  // exactly the fitted shot — with the blurred backdrop filling the rest.
  if (item.kind === "photo") {
    return {
      label,
      filter: blurredFit({
        inputIndex: item.inputIndex, index, frames, width, height, eq,
        scaleUp: 1.25, baseZoom: 1.25, slowZoom: 0.035,
        move, label,
      }),
    };
  }

  // Video clip: cover-crop to fill + colour lift. With no entrance move, keep
  // the cheap plain cover-crop; otherwise route through zoompan for the move.
  //
  // Slow-mo (director-marked, speed 0.5): the input feeds duration*speed seconds
  // of source (see addInput) and setpts stretches them to the full slice, so the
  // segment still ends exactly on its beat. NORM's fps=30 duplicates frames to
  // fill the stretched timestamps — fine on a phone screen; no audio to retime
  // (the music track is the only audio).
  const speed = item.speed && item.speed > 0 && item.speed < 1 ? item.speed : 1;
  const trim =
    speed !== 1
      ? `setpts=${(1 / speed).toFixed(4)}*(PTS-STARTPTS),trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,`
      : `trim=0:${item.duration.toFixed(3)},setpts=PTS-STARTPTS,`;
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

// Per-style transition vocabulary. Most beats get a near-instant `cutDur` fade
// (reads as a hard cut so the beat still hits); every `every`-th boundary gets a
// real effect from `effects` (whip slides, circle/radial zoom, dissolve). All
// names are xfade transitions available since ffmpeg 4.3.
// Uses the flashy transitions ffmpeg 5.1 already ships — zoomin (the Canva zoom),
// hblur (motion-blur whip), pixelize (glitch), radial/circle/squeeze/slice —
// no GL library needed. `every` = one real effect per N beats (rest are quick
// cut-like fades so the beat still hits).
const TRANSITION_SETS = {
  beatcut:   { effects: ["zoomin", "slideleft", "slideright", "hblur", "smoothleft"],            effectDur: 0.20, cutDur: 0.05, every: 2 },
  punchy:    { effects: ["zoomin", "hblur", "slideleft", "slideright", "pixelize"],              effectDur: 0.20, cutDur: 0.05, every: 2 },
  dynamic:   { effects: ["zoomin", "radial", "circleopen", "squeezeh", "hlslice", "slidedown"],  effectDur: 0.26, cutDur: 0.05, every: 2 },
  clean:     { effects: ["dissolve", "zoomin", "smoothright", "fadeslow"],                       effectDur: 0.30, cutDur: 0.06, every: 3 },
  cinematic: { effects: ["fade", "fadeblack", "dissolve", "fadeslow"],                           effectDur: 0.50, cutDur: 0.50, every: 1 },
};
const DEFAULT_TRANSITION = { effects: ["fade", "dissolve"], effectDur: 0.3, cutDur: 0.06, every: 2 };

// Transitions that read as "soft" — used to decide which beats get a zoom-punch
// (only the non-soft, flashy ones do).
const SMOOTH_TRANSITIONS = new Set(["fade", "fadeblack", "fadewhite", "fadeslow", "fadefast", "dissolve"]);

// Below this music energy (0..1) a boundary cuts quietly (quick fade) even if
// the cadence would have given it a flashy effect. Whip-slides through a calm
// verse read as random; saved for the hot stretches they read as musical.
const ENERGY_FLASHY_MIN = 0.45;

// Build the per-boundary plan ([{ type, dur }] of length n). The boundary INTO
// the end card always gets a clean dip-to-black so the branded card lands well.
// boundaryEnergies (optional, from the beat analysis) gates the flashy effects
// to the high-energy stretches of the track; null entries mean "unknown" and
// keep the plain cadence behaviour.
function buildTransitionPlan(n, style, cardIndex, boundaryEnergies = []) {
  const t = TRANSITION_SETS[style.name] || DEFAULT_TRANSITION;
  const effects = t.effects.length ? t.effects : ["fade"];
  const start = Math.floor(Math.random() * effects.length);
  const plan = [];
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (i + 1 === cardIndex) { plan.push({ type: "fadeblack", dur: Math.max(0.3, t.effectDur) }); continue; }
    const energy = boundaryEnergies[i];
    const hot = energy == null || energy >= ENERGY_FLASHY_MIN;
    if (t.every >= 1 && i % t.every === 0 && hot) {
      plan.push({ type: effects[(start + e) % effects.length], dur: t.effectDur });
      e++;
    } else {
      plan.push({ type: "fade", dur: t.cutDur });
    }
  }
  return plan;
}

// Chains segments with xfade using a per-boundary plan. Padding (done by the
// caller) makes each transition RESOLVE exactly on its beat, so the edit stays
// beat-locked and the total is preserved.
function xfadeChain(segmentLabels, durations, plan) {
  const filters = [];
  let cumulative = durations[0];
  let prevLabel = segmentLabels[0];

  for (let i = 1; i < segmentLabels.length; i++) {
    const outLabel = i === segmentLabels.length - 1 ? "vmain" : `x${i}`;
    const { type, dur } = plan[i - 1];
    const offset = Math.max(0, cumulative - dur);
    filters.push(
      `[${prevLabel}][${segmentLabels[i]}]xfade=transition=${type}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`,
    );
    cumulative += durations[i] - dur;
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
// Slow-mo videos need only duration*speed seconds of source — setpts stretches
// them to the full slice in the filter graph (so slow-mo can never run out of
// source material, unlike speed-UP, which is why we don't offer it).
function addInput(command, sub, duration) {
  if (sub.kind === "video") {
    const speed = sub.speed && sub.speed > 0 && sub.speed < 1 ? sub.speed : 1;
    command
      .input(sub.storedPath)
      .inputOptions([`-ss ${(sub.trimStart ?? 0).toFixed(3)}`, `-t ${(duration * speed).toFixed(3)}`]);
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
  hook,
  boundaryEnergies = [],
  outputPath,
  onProgress,
}) {
  const width = config.render.width;
  const height = config.render.height;
  const style = styleArg || getStyle(null);

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

  // Build the per-boundary transition plan, then pad each segment (after the
  // first) by its INCOMING transition length. xfade steals `dur` from each
  // boundary, so this padding both preserves the 30s total AND makes every
  // transition resolve exactly on its beat (cuts stay beat-locked).
  const plan = buildTransitionPlan(comp.length - 1, style, comp.length - 1, boundaryEnergies);
  comp = comp.map((it, i) => {
    if (i === 0) return it;
    const d = plan[i - 1].dur;
    const padded = { ...it, duration: it.duration + d };
    for (const k of ["a", "b", "c"]) {
      if (it[k]) padded[k] = { ...it[k], duration: it[k].duration + d };
    }
    return padded;
  });

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

  // Real xfade transitions now carry the between-clip energy, so clips stay calm
  // (gentle Ken Burns only) — the old per-cut zoom/slide moves ON TOP of the
  // transitions read as "too much motion". Keep them off.
  // Beat zoom-punch: a subtle zoom-in-and-settle on the ACCENT beats only — the
  // clips that already get a flashy transition (zoomin/hblur/slide/…). Smooth
  // transitions (fades/dissolves) and the card don't punch, so calm styles stay
  // calm and we don't reintroduce the old "constant motion" feel.
  const segments = comp.map((item, index) => {
    const inc = plan[index - 1];
    const accent = index > 0 && inc && !SMOOTH_TRANSITIONS.has(inc.type)
      && (item.kind === "photo" || item.kind === "video");
    return segmentFilter({
      item, index, width, height, grade: style.grade, panPx: style.panPx ?? 50,
      entrance: accent ? "punch" : "none",
    });
  });
  const durations = comp.map((item) => item.duration);

  const chain = xfadeChain(segments.map((s) => s.label), durations, plan);
  const joinFilters = chain.filters;
  const totalDuration = chain.totalDuration;

  // Canva-style ANIMATED title over the opening shot: bold "FESTIVAL RECAP" +
  // event name/location beneath, each sliding up as it fades in (staggered) and
  // fading back out — instead of the old hard pop on/off.
  // (Vignette PARKED with the grade — re-enable by prefixing the first drawtext
  //  input with `vignette=angle=PI/4.5,`.)
  // The director's hook (e.g. "BEST NIGHT EVER") becomes the bold opening line
  // when present; otherwise the generic "FESTIVAL RECAP".
  // Every drawtext line is written to a temp file; track them all so none leak
  // (the count now varies with how many sub-lines the project has).
  const textFiles = [];
  const textFile = async (s) => {
    const p = await writeTextFile(s);
    textFiles.push(p);
    return p;
  };

  const mainText = (hook || "FESTIVAL RECAP").toUpperCase();
  const mainPath = await textFile(mainText);
  // buildTitleSub joins "event\nlocation" — split so each line gets its own
  // weight/colour (the event name carries the brand orange).
  const subLines = String(titleSubText || eventName || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const eventLine = subLines[0] || "";
  const locLine = subLines.slice(1).join(" · ");

  // Auto-shrink so a long hook fits instead of running off both edges. CHAR_ADV
  // is the rough advance width per char for this font (uppercase), as a fraction
  // of fontsize. 0.62 was measured too low — "FESTIVAL FUN UNLEASHED!" rendered
  // edge-to-edge — so it's 0.70 with a 90% width budget: better a slightly
  // smaller title than a clipped one. (drawtext can't size itself: fontsize
  // takes no expression, so text_w is only knowable after the fact.)
  const CHAR_ADV = 0.7;
  const maxTitleW = width * 0.9;
  const fitSize = Math.floor(maxTitleW / Math.max(1, mainText.length * CHAR_ADV));
  const titleMainSize = Math.max(40, Math.min(style.titleMainSize, fitSize));
  const eventSize = style.titleSubSize + 4;
  const locSize = Math.max(26, style.titleSubSize - 8);

  const tEnd = TITLE_SECONDS;       // when the title is fully gone
  const D = 0.35;                    // fade in/out length
  // alpha ramp: 0 -> 1 over D from tIn, hold, 1 -> 0 over D ending at tEnd
  const alphaExpr = (tIn) =>
    `if(lt(t,${tIn}),0,if(lt(t,${tIn}+${D}),(t-${tIn})/${D},if(lt(t,${tEnd}-${D}),1,if(lt(t,${tEnd}),(${tEnd}-t)/${D},0))))`;
  // y slides up 34px into place over the first 0.4s after tIn
  const slideY = (baseY, tIn) => `(${baseY})+34*(1-min(1,max(0,(t-${tIn}))/0.4))`;
  const en = `enable='lt(t,${tEnd})'`;

  // A heavier treatment than plain white + a hairline outline, which vanished
  // into busy festival shots: thick dark outline AND an offset drop shadow, so
  // the text reads over anything.
  const drawText = ({ path, size, color, y, tIn, borderw }) =>
    `drawtext=textfile='${path}':fontfile='${FONT_FILE}':fontsize=${size}:fontcolor=${color}:` +
    `borderw=${borderw}:bordercolor=black@0.8:shadowcolor=black@0.55:shadowx=3:shadowy=3:` +
    `x=(w-text_w)/2:y='${slideY(y, tIn)}':alpha='${alphaExpr(tIn)}':${en}`;

  // Chain the lines, staggered, so they cascade in rather than popping together.
  const textFilters = [];
  let cur = "vmain";
  const chainText = (filter) => {
    const next = `vt${textFilters.length + 1}`;
    textFilters.push(`[${cur}]${filter}[${next}]`);
    cur = next;
  };

  chainText(drawText({ path: mainPath, size: titleMainSize, color: "white", y: "h*0.09", tIn: 0, borderw: 6 }));
  let nextY = `h*0.09+${titleMainSize + 26}`;
  if (eventLine) {
    chainText(
      drawText({ path: await textFile(eventLine), size: eventSize, color: BRAND_ORANGE, y: nextY, tIn: 0.2, borderw: 4 }),
    );
    nextY = `h*0.09+${titleMainSize + 26 + eventSize + 8}`;
  }
  if (locLine) {
    chainText(
      drawText({ path: await textFile(locLine), size: locSize, color: "white@0.85", y: nextY, tIn: 0.32, borderw: 3 }),
    );
  }
  // Always land on [vout] whatever got chained (null = free passthrough rename).
  textFilters.push(`[${cur}]null[vout]`);

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
      ...textFiles.map((p) => unlink(p).catch(() => {})),
      endCardPath ? unlink(endCardPath).catch(() => {}) : Promise.resolve(),
    ]);
  }

  return { outputPath, totalDuration };
}
