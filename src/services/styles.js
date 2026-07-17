// Style presets for varied Shorts edits. Each render picks one at RANDOM so a
// creator's feed doesn't look repetitive — fresh formats help both retention
// and the algorithm. A preset feeds:
//   - selection.js  → pace (targetSlice), close-up weighting (closeupBias),
//                     hero holds (heroHold), split-screen moments (splitMoments)
//   - videoComposer → colour grade, title sizes, photo drift (panPx)
//   - music pick    → preferred genre/vibe (when the project's style is "auto")
//
// TRANSITIONS ARE NOT DEFINED HERE. They live in videoComposer's TRANSITION_SETS,
// keyed by style NAME. This file used to also carry `hardCuts`/`transitions`/
// `transitionDuration` fields that nothing read — they described the old concat
// design and survived the move to xfade, so they sat here for months contradicting
// what actually shipped. Removed: a field that lies is worse than no field.
// Change a style's cut feel in TRANSITION_SETS, not here.
//
// Canva-derived ground rules (from studying reference edits frame by frame):
//   * shots stay essentially STILL — the cuts carry the energy (small panPx)
//   * transitions are SHORT (≤0.4s); long dissolves smear frames and read dizzy
//   * hero close-ups (food, faces) are held 2x+ as "moments"
//   * the title is an event: big bold FESTIVAL RECAP + event/location, held ~3s
//   * occasional split-screen (two clips stacked) adds playful geometry

export const STYLES = [
  {
    // The Canva reference format, reverse-engineered clip-by-clip:
    // 0-1s hook (full-screen hero close-up + bold text) → ~1-4s a 3-panel
    // stacked split whose MIDDLE panel stays static while top/bottom swap on
    // the beat → rapid full-screen HARD cuts (1.0-1.5s, zero transition
    // effects) → a 0.5s bounce-back to an earlier shot → end card.
    // Cuts are pure concat (no xfade smear) and every duration is an exact
    // beat multiple, so cuts land on the kick.
    name: "beatcut",
    label: "Canva / Beat-Cut",
    targetSlice: 1.2, // 1.0-1.5s micro-clips, beat-snapped
    grade: { saturation: 1.35, contrast: 1.06, brightness: 0.03 }, // vibrant realism
    closeupBias: 1.4,
    heroHold: 1, // uniform fast pace — no long holds in this format
    splitMoments: 0, // uses the split3 structure instead of 2-up splits
    structure: { hook: true, split3: 2, bounceBack: true },
    musicGenre: "edm",
    titleMainSize: 96,
    titleSubSize: 44,
    panPx: 0, // shots dead still; handheld source motion is the texture
  },
  {
    name: "punchy",
    label: "Punchy / Trend",
    targetSlice: 1.2, // fast cuts
    grade: { saturation: 1.3, contrast: 1.08, brightness: 0.02 },
    closeupBias: 1.35,
    heroHold: 1.8, // close-ups held ~2.2s while crowd shots stay snappy
    splitMoments: 1,
    musicGenre: "edm",
    titleMainSize: 96,
    titleSubSize: 44,
    panPx: 25, // near-still: the fast cuts ARE the motion
  },
  {
    name: "cinematic",
    label: "Smooth Cinematic",
    targetSlice: 2.0, // calm
    grade: { saturation: 1.14, contrast: 1.03, brightness: 0.0 },
    closeupBias: 1.1,
    heroHold: 1.6,
    splitMoments: 0, // no gimmicks — this style is about calm holds
    musicGenre: "cinematic",
    titleMainSize: 84,
    titleSubSize: 40,
    panPx: 70, // slow, barely-perceptible drift
  },
  {
    name: "dynamic",
    label: "Dynamic / Motion",
    targetSlice: 1.5,
    grade: { saturation: 1.25, contrast: 1.05, brightness: 0.02 },
    closeupBias: 1.2,
    heroHold: 1.7,
    splitMoments: 2,
    musicGenre: "electronic",
    titleMainSize: 90,
    titleSubSize: 42,
    panPx: 90, // the most motion of any style — still gentle
  },
  {
    name: "clean",
    label: "Clean / Minimal",
    targetSlice: 1.7,
    grade: { saturation: 1.18, contrast: 1.04, brightness: 0.0 },
    closeupBias: 1.0,
    heroHold: 1.5,
    splitMoments: 1,
    musicGenre: "festival",
    titleMainSize: 80,
    titleSubSize: 40,
    panPx: 45,
  },
];

export function pickRandomStyle() {
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

// A style's targetSlice is in SECONDS, and every preset above was tuned against
// ~128 BPM dance music. selection.js can only cut ON beats, so it rounds the
// slice to the nearest whole beat (its beatsFor). At 128 BPM (0.47s/beat) that
// rounding is nearly free; at reggae's ~75 BPM (0.8s/beat) "beatcut"'s 1.2s
// micro-cuts round to 1.6s — a third slower, which is the whole identity of the
// style gone. Measure that as a fraction of what the style asked for.
export function sliceDistortion(style, bpm) {
  const beat = 60 / bpm;
  const beats = Math.max(1, Math.round(style.targetSlice / beat));
  return Math.abs(beats * beat - style.targetSlice) / style.targetSlice;
}

// Epsilon because the comparison sits right on a float boundary: at 75 BPM
// "cinematic" scores 0.20000000000000018, and without slack a style's fate is
// decided by binary rounding noise rather than by pacing.
const MAX_SLICE_DISTORTION = 0.2 + 1e-9;

// Pick a style whose intended pace SURVIVES beat-rounding at this track's tempo.
// Keyed on measured BPM rather than a genre name, so it works for genres nobody
// wrote a preset for. At ~128 BPM every style qualifies (so "auto" behaves as it
// always did); at ~75 BPM the two EDM hard-cut styles drop out and the slower,
// smoother ones remain. Falls back to the least-distorted style if none pass,
// and to a plain random pick when BPM is unknown.
export function pickStyleForBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return pickRandomStyle();
  const fits = STYLES.filter((s) => styleFitsBpm(s, bpm));
  if (fits.length) return fits[Math.floor(Math.random() * fits.length)];
  return STYLES.reduce((best, s) => (sliceDistortion(s, bpm) < sliceDistortion(best, bpm) ? s : best));
}

// Would this style's pace still be recognisable at this tempo? Exported so the
// render worker can re-judge a style that was chosen at QUEUE time (from the
// track's stored bpm) against the tempo it actually MEASURED at render time.
// An unknown tempo returns true: no measurement is no grounds to reject.
export function styleFitsBpm(style, bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return true;
  return sliceDistortion(style, bpm) <= MAX_SLICE_DISTORTION;
}

export function getStyle(name) {
  return STYLES.find((s) => s.name === name) || STYLES[STYLES.length - 1];
}
