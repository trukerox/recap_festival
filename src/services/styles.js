// Style presets for varied Shorts edits. Each render picks one at RANDOM so a
// creator's feed doesn't look repetitive — fresh formats help both retention
// and the algorithm. A preset feeds:
//   - selection.js  → pace (targetSlice), close-up weighting (closeupBias),
//                     hero holds (heroHold), split-screen moments (splitMoments)
//   - videoComposer → transitions, transition length, colour grade, title sizes,
//                     photo drift (panPx)
//   - music pick    → preferred genre/vibe (when the project's style is "auto")
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
    hardCuts: true, // concat, not xfade — instant cuts
    transitions: [], // unused with hardCuts
    transitionDuration: 0,
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
    hardCuts: true, // instant cuts on the beat
    transitions: [],
    transitionDuration: 0,
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
    transitions: ["fade", "fadeblack", "fade"],
    transitionDuration: 0.4, // longest allowed — anything more smears
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
    hardCuts: true, // instant cuts on the beat
    transitions: [],
    transitionDuration: 0,
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
    hardCuts: true, // instant cuts on the beat
    transitions: [],
    transitionDuration: 0,
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

export function getStyle(name) {
  return STYLES.find((s) => s.name === name) || STYLES[STYLES.length - 1];
}
