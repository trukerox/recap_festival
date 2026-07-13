// Turns scored media into the 20s timeline structure the brief describes:
//   0-3s   strong opening shot (highest-scoring clip/photo)
//   3-17s  fast-paced highlights, alternating wide/close shots where possible
//   17-20s final emotional shot (held for the CTA overlay)
// Clip lengths in the highlight section are snapped to the music's beat grid
// so cuts land on-beat ("fast cuts synchronized with music").
const OPENING_SECONDS = 3;
const CLOSING_SECONDS = 3;
const MIN_SLICE_SECONDS = 0.7;
const MAX_SLICE_SECONDS = 2.5;
const TARGET_SLICE_SECONDS = 1.4;

function beatSnappedSlice(bpm) {
  if (!bpm) return TARGET_SLICE_SECONDS;
  const beatSeconds = 60 / bpm;
  const beats = Math.max(1, Math.round(TARGET_SLICE_SECONDS / beatSeconds));
  return Math.min(MAX_SLICE_SECONDS, Math.max(MIN_SLICE_SECONDS, beats * beatSeconds));
}

function toTimelineItem(row, role, duration) {
  const isVideo = row.kind === "video";
  return {
    mediaItemId: row.id,
    kind: row.kind,
    storedPath: row.stored_path,
    role,
    duration,
    shotType: row.shot_type,
    // Source dimensions so the composer can pan landscape photos across their
    // width instead of center-cropping them (see videoComposer.segmentFilter).
    srcWidth: row.width ?? null,
    srcHeight: row.height ?? null,
    // For video, trim to the pre-scored best window, but never exceed `duration`.
    trimStart: isVideo ? Number(row.trim_start_seconds ?? 0) : null,
    trimEnd: isVideo ? Number(row.trim_start_seconds ?? 0) + duration : null,
  };
}

export function buildTimeline(scoredMediaRows, { bpm, totalDurationSeconds }) {
  const ranked = [...scoredMediaRows].sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
  if (ranked.length < 3) throw new Error("Need at least 3 scored media items to build a timeline");

  const opening = ranked[0];
  // Prefer a photo (or a still-feeling clip) for the closing hold, so the CTA
  // text is easy to read over a calmer frame rather than mid-motion video.
  const closingCandidates = ranked.slice(1).filter((r) => r.kind === "photo");
  const closing = closingCandidates[0] ?? ranked[1];

  const used = new Set([opening.id, closing.id]);
  const middlePool = ranked.filter((r) => !used.has(r.id));

  const middleBudget = Math.max(0, totalDurationSeconds - OPENING_SECONDS - CLOSING_SECONDS);
  const slice = beatSnappedSlice(bpm);
  const middleSlots = Math.max(1, Math.floor(middleBudget / slice));

  // Alternate wide/close shot types for visual rhythm when both are available;
  // fall back to score order otherwise.
  const wide = middlePool.filter((r) => r.shot_type === "wide");
  const close = middlePool.filter((r) => r.shot_type === "close");
  const other = middlePool.filter((r) => r.shot_type !== "wide" && r.shot_type !== "close");
  const interleaved = [];
  let wi = 0, ci = 0, oi = 0;
  while (interleaved.length < middleSlots && (wi < wide.length || ci < close.length || oi < other.length)) {
    if (wi < wide.length) interleaved.push(wide[wi++]);
    if (interleaved.length < middleSlots && ci < close.length) interleaved.push(close[ci++]);
    if (interleaved.length < middleSlots && oi < other.length) interleaved.push(other[oi++]);
  }
  const middle = interleaved.slice(0, middleSlots);

  // Distribute any leftover seconds (from flooring) across the last middle
  // slot and the closing shot so the timeline sums exactly to the target.
  const usedMiddle = middle.length * slice;
  const leftover = middleBudget - usedMiddle;

  const timeline = [
    toTimelineItem(opening, "opening", OPENING_SECONDS),
    ...middle.map((row, i) => toTimelineItem(row, "highlight", slice + (i === middle.length - 1 ? leftover : 0))),
    toTimelineItem(closing, "closing", CLOSING_SECONDS),
  ];

  return timeline;
}
