// Turns scored media into the recap timeline:
//   0-3s    strong opening shot (highest-scoring item) under the title card
//   middle  highlights — beat-snapped cuts, hero holds on close-ups, and
//           optional split-screen moments (two clips stacked), per style
//   last 3s branded end card (composer swaps the closing slot for it)
//
// Canva-derived pacing rules: close-up "hero" shots (food, faces) get held
// noticeably longer than crowd shots; split-screen moments add playful
// geometry in styles that call for them.
const OPENING_SECONDS = 3;
const CLOSING_SECONDS = 3;
const MIN_SLICE_SECONDS = 0.7;
const MAX_SLICE_SECONDS = 2.6;
const MAX_HERO_SECONDS = 2.8;
const DEFAULT_TARGET_SLICE = 1.5;

function beatSnappedSlice(bpm, targetSlice) {
  if (!bpm) return targetSlice;
  const beatSeconds = 60 / bpm;
  const beats = Math.max(1, Math.round(targetSlice / beatSeconds));
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
    srcWidth: row.width ?? null,
    srcHeight: row.height ?? null,
    // For video, trim to the pre-scored best window, but never exceed `duration`.
    trimStart: isVideo ? Number(row.trim_start_seconds ?? 0) : null,
    trimEnd: isVideo ? Number(row.trim_start_seconds ?? 0) + duration : null,
  };
}

// A split-screen moment: two clips stacked vertically for one slice.
function toSplitItem(rowA, rowB, duration) {
  return {
    kind: "split",
    role: "highlight",
    duration,
    a: toTimelineItem(rowA, "split-panel", duration),
    b: toTimelineItem(rowB, "split-panel", duration),
  };
}

export function buildTimeline(
  scoredMediaRows,
  {
    bpm,
    totalDurationSeconds,
    targetSlice = DEFAULT_TARGET_SLICE,
    closeupBias = 1,
    heroHold = 1,
    splitMoments = 0,
  },
) {
  // Apply the style's close-up bias to the ranking so detail shots (the hero
  // food/close moments) get featured more in styles that call for it.
  const scoreOf = (r) => (r.composite_score ?? 0) * (r.shot_type === "close" ? closeupBias : 1);
  const ranked = [...scoredMediaRows].sort((a, b) => scoreOf(b) - scoreOf(a));
  if (ranked.length < 3) throw new Error("Need at least 3 scored media items to build a timeline");

  const opening = ranked[0];
  // Prefer a photo (or a still-feeling clip) for the closing hold, so the CTA
  // text is easy to read over a calmer frame rather than mid-motion video.
  const closingCandidates = ranked.slice(1).filter((r) => r.kind === "photo");
  const closing = closingCandidates[0] ?? ranked[1];

  const used = new Set([opening.id, closing.id]);
  const middlePool = ranked.filter((r) => !used.has(r.id));

  // Interleave wide/close/other for visual rhythm, as before.
  const wide = middlePool.filter((r) => r.shot_type === "wide");
  const close = middlePool.filter((r) => r.shot_type === "close");
  const other = middlePool.filter((r) => r.shot_type !== "wide" && r.shot_type !== "close");
  const queue = [];
  let wi = 0, ci = 0, oi = 0;
  while (wi < wide.length || ci < close.length || oi < other.length) {
    if (wi < wide.length) queue.push(wide[wi++]);
    if (ci < close.length) queue.push(close[ci++]);
    if (oi < other.length) queue.push(other[oi++]);
  }

  const middleBudget = Math.max(0, totalDurationSeconds - OPENING_SECONDS - CLOSING_SECONDS);
  const slice = beatSnappedSlice(bpm, targetSlice);
  const heroSlice = Math.min(MAX_HERO_SECONDS, slice * Math.max(1, heroHold));

  // Fill the middle greedily: close-ups get hero holds, and split-screen
  // moments are dropped in at spaced slot positions while footage allows.
  const middle = [];
  let spent = 0;
  let slot = 0;
  let splitsLeft = Math.max(0, splitMoments);
  const splitSlots = new Set(splitMoments > 0 ? [2, 6, 10] : []);

  while (queue.length > 0 && spent + MIN_SLICE_SECONDS <= middleBudget) {
    if (splitsLeft > 0 && splitSlots.has(slot) && queue.length >= 2 && spent + slice <= middleBudget) {
      const a = queue.shift();
      const b = queue.shift();
      middle.push(toSplitItem(a, b, slice));
      spent += slice;
      splitsLeft--;
    } else {
      const row = queue.shift();
      const isHero = row.shot_type === "close";
      const dur = Math.min(isHero ? heroSlice : slice, middleBudget - spent);
      if (dur < MIN_SLICE_SECONDS) break;
      middle.push(toTimelineItem(row, "highlight", dur));
      spent += dur;
    }
    slot++;
  }

  // Absorb any leftover seconds into the last middle entry so the timeline
  // sums exactly to the target.
  const leftover = middleBudget - spent;
  if (middle.length > 0 && leftover > 0.01) {
    middle[middle.length - 1].duration += leftover;
    if (middle[middle.length - 1].kind === "split") {
      middle[middle.length - 1].a.duration += leftover;
      middle[middle.length - 1].b.duration += leftover;
    }
  }

  return [
    toTimelineItem(opening, "opening", OPENING_SECONDS),
    ...middle,
    toTimelineItem(closing, "closing", CLOSING_SECONDS),
  ];
}
