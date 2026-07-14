// Style presets for varied Shorts edits. Each render picks one at RANDOM so a
// creator's feed doesn't look repetitive — fresh formats help both retention
// and the algorithm. A preset feeds:
//   - selection.js  → pace (targetSlice) + which shots to favour (closeupBias)
//   - videoComposer → transitions, transition length, colour grade, title size
//   - music pick    → preferred genre/vibe (when the project's style is "auto")
//
// Transition names are ffmpeg xfade transitions (all present in ffmpeg 5.1):
// fade, fadeblack, fadewhite, dissolve, wipe*, slide*, smooth*, circleopen/close.

export const STYLES = [
  {
    name: "punchy",
    label: "Punchy / Trend",
    transitions: ["fadeblack", "fade", "fadeblack", "fade"], // dips to black on the beat
    transitionDuration: 0.3,
    targetSlice: 1.2, // fast cuts
    grade: { saturation: 1.3, contrast: 1.08, brightness: 0.02 },
    closeupBias: 1.35,
    musicGenre: "edm",
    titleFontSize: 74,
  },
  {
    name: "cinematic",
    label: "Smooth Cinematic",
    transitions: ["fade", "dissolve", "fade"],
    transitionDuration: 0.6, // long, elegant crossfades
    targetSlice: 2.0, // calm
    grade: { saturation: 1.14, contrast: 1.03, brightness: 0.0 },
    closeupBias: 1.1,
    musicGenre: "cinematic",
    titleFontSize: 62,
  },
  {
    name: "dynamic",
    label: "Dynamic / Motion",
    transitions: ["slideleft", "slideright", "smoothup", "circleopen"],
    transitionDuration: 0.4,
    targetSlice: 1.5,
    grade: { saturation: 1.25, contrast: 1.05, brightness: 0.02 },
    closeupBias: 1.2,
    musicGenre: "electronic",
    titleFontSize: 68,
  },
  {
    name: "clean",
    label: "Clean / Minimal",
    transitions: ["fade", "fade", "dissolve"],
    transitionDuration: 0.45,
    targetSlice: 1.7,
    grade: { saturation: 1.18, contrast: 1.04, brightness: 0.0 },
    closeupBias: 1.0,
    musicGenre: "festival",
    titleFontSize: 60,
  },
];

export function pickRandomStyle() {
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

export function getStyle(name) {
  return STYLES.find((s) => s.name === name) || STYLES[STYLES.length - 1];
}
