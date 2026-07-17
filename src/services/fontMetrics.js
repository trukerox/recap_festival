// How wide will this text actually render? Read straight from the TTF.
//
// drawtext CANNOT size itself: fontsize takes no expression, and text_w is only
// knowable after the glyphs are laid out — by which point the filter string is
// already built. So the composer has to know the width in advance.
//
// It used to ESTIMATE: chars * CHAR_ADV * fontsize, with CHAR_ADV a hand-tuned
// constant. That was guessed three times (0.62 -> 0.70 for DejaVu -> 0.54 for
// Anton), wrong every time, and measuring the fonts showed WHY no fourth guess
// would have worked either:
//
//   Anton "IIIII" -> 0.227/char      "WOWWW" -> 0.667/char      (2.9x spread)
//   real hooks average 0.417, but an 18-char all-W hook needs 0.71 to not clip
//
// Any single constant either shrinks normal hooks (0.71 costs 40%) or overflows
// wide ones — the current 0.54 clips an 18-char wide-glyph hook at 1281px against
// a 972px budget. The question has no answer; measuring the actual string does.
//
// This is what freetype does when drawtext renders, so it agrees by construction.
// Zero dependencies, and fonts are parsed once and cached.
import { readFileSync } from "node:fs";
import logger from "../utils/logger.js";

const cache = new Map(); // fontFile -> { unitsPerEm, advances, glyphOf } | null

function parseFont(path) {
  const b = readFileSync(path);
  const numTables = b.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[b.toString("ascii", o, o + 4).trim()] = { off: b.readUInt32BE(o + 8) };
  }
  for (const t of ["head", "hhea", "hmtx", "cmap"]) {
    if (!tables[t]) throw new Error(`missing ${t} table`);
  }

  const unitsPerEm = b.readUInt16BE(tables.head.off + 18);
  const numberOfHMetrics = b.readUInt16BE(tables.hhea.off + 34);
  if (!unitsPerEm || !numberOfHMetrics) throw new Error("bad head/hhea");

  // hmtx: numberOfHMetrics longHorMetric records. Glyphs past that reuse the LAST
  // advance (the format's monospaced-tail trick) — hence the clamp in advanceOf.
  const advances = new Array(numberOfHMetrics);
  for (let i = 0; i < numberOfHMetrics; i++) advances[i] = b.readUInt16BE(tables.hmtx.off + i * 4);

  // cmap: a Unicode format-4 subtable (3,1 preferred; 0,x acceptable).
  const cmapOff = tables.cmap.off;
  const nSub = b.readUInt16BE(cmapOff + 2);
  let sub = null;
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = b.readUInt16BE(rec);
    const encoding = b.readUInt16BE(rec + 2);
    const off = cmapOff + b.readUInt32BE(rec + 4);
    if (b.readUInt16BE(off) === 4 && (platform === 3 || platform === 0)) {
      sub = off;
      if (platform === 3 && encoding === 1) break;
    }
  }
  if (sub == null) throw new Error("no format-4 cmap");

  const segX2 = b.readUInt16BE(sub + 6);
  const seg = segX2 / 2;
  const endO = sub + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;

  const glyphOf = (code) => {
    for (let i = 0; i < seg; i++) {
      if (code > b.readUInt16BE(endO + i * 2)) continue;
      const start = b.readUInt16BE(startO + i * 2);
      if (code < start) return 0;
      const delta = b.readInt16BE(deltaO + i * 2);
      const rangeOff = b.readUInt16BE(rangeO + i * 2);
      if (rangeOff === 0) return (code + delta) & 0xffff;
      const g = b.readUInt16BE(rangeO + i * 2 + rangeOff + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  return { unitsPerEm, advances, glyphOf };
}

function getFont(fontFile) {
  if (cache.has(fontFile)) return cache.get(fontFile);
  let f = null;
  try {
    f = parseFont(fontFile);
  } catch (err) {
    // Never fatal: the caller falls back to a conservative estimate, which costs a
    // slightly small title. A render must not die over type metrics.
    logger.warn({ err: err.message, fontFile }, "could not read font metrics — falling back to estimate");
  }
  cache.set(fontFile, f);
  return f;
}

// Rendered width of `text` at `fontsize`, in px. null if the font can't be read.
export function textWidthPx(fontFile, text, fontsize) {
  const f = getFont(fontFile);
  if (!f) return null;
  let units = 0;
  for (const ch of text) {
    const g = f.glyphOf(ch.codePointAt(0));
    units += f.advances[Math.min(g, f.advances.length - 1)];
  }
  return (units / f.unitsPerEm) * fontsize;
}

// Largest fontsize (<= maxSize) at which `text` fits inside maxWidthPx. Width
// scales linearly with fontsize, so one measurement answers it exactly.
//
// fallbackAdv is only used when the font can't be parsed. It's deliberately
// pessimistic — better a small title than one running off both edges.
export function fitFontSize(fontFile, text, maxWidthPx, maxSize, fallbackAdv = 0.75) {
  const w = textWidthPx(fontFile, text, 100);
  if (!w) {
    const est = Math.floor(maxWidthPx / Math.max(1, text.length * fallbackAdv));
    return Math.min(maxSize, est);
  }
  return Math.min(maxSize, Math.floor((maxWidthPx / w) * 100));
}
