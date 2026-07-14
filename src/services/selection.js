// Turns scored media into the recap timeline.
//
// Default structure:
//   0-3s    strong opening shot (highest-scoring item) under the title card
//   middle  highlights — beat-snapped cuts, hero holds on close-ups, and
//           optional 2-up split-screen moments, per style
//   last 3s branded end card (composer swaps the closing slot for it)
//
// "beatcut" structure (style.structure — the Canva reference format):
//   ~1s     hook: full-screen hero close-up under the bold title
//   ~1-4s   3-panel stacked splits whose MIDDLE panel stays the hook shot
//           while top/bottom swap on the beat
//   middle  rapid full-screen micro-clips (1.0-1.5s)
//   1 beat  bounce-back: an earlier shot flashes again
//   end     branded end card
//
// AUDIO-SYNC IS LAW: every cut must land on the music's beat grid. All slice
// durations here are exact multiples of 60/bpm (hero holds included), and any
// non-divisible leftover is absorbed by the CLOSING slot (the end card), never
// by a mid-timeline slice — so the grid stays intact from the first cut to
// the cut into the card.
const OPENING_SECONDS = 3;
const CLOSING_SECONDS = 3;
const MIN_SLICE_SECONDS = 0.7;
const MAX_SLICE_SECONDS = 2.6;
const MAX_HERO_SECONDS = 2.8;
const DEFAULT_TARGET_SLICE = 1.5;
const HOOK_TARGET_SECONDS = 1.0;
const SPLIT3_TARGET_SECONDS = 1.2;
const BOUNCE_TARGET_SECONDS = 0.5;

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

// A 2-up split-screen moment: two clips stacked vertically for one slice.
function toSplitItem(rowA, rowB, duration) {
  return {
    kind: "split",
    role: "highlight",
    duration,
    a: toTimelineItem(rowA, "split-panel", duration),
    b: toTimelineItem(rowB, "split-panel", duration),
  };
}

// A 3-panel stacked split (beatcut structure): top/middle/bottom.
function toSplit3Item(rowTop, rowMiddle, rowBottom, duration) {
  return {
    kind: "split3",
    role: "highlight",
    duration,
    a: toTimelineItem(rowTop, "split-panel", duration),
    b: toTimelineItem(rowMiddle, "split-panel", duration),
    c: toTimelineItem(rowBottom, "split-panel", duration),
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
    structure = null,
  },
) {
  const beat = bpm ? 60 / bpm : null;
  // Snap a duration to the nearest whole number of beats (min 1 beat), capped
  // so a slow track can't stretch a micro-clip past maxSeconds.
  const snapBeats = (seconds, maxSeconds = MAX_SLICE_SECONDS) => {
    if (!beat) return Math.min(seconds, maxSeconds);
    let beats = Math.max(1, Math.round(seconds / beat));
    while (beats > 1 && beats * beat > maxSeconds) beats--;
    return beats * beat;
  };

  // Apply the style's close-up bias to the ranking so detail shots (the hero
  // food/close moments) get featured more in styles that call for it.
  const scoreOf = (r) => (r.composite_score ?? 0) * (r.shot_type === "close" ? closeupBias : 1);
  const ranked = [...scoredMediaRows].sort((a, b) => scoreOf(b) - scoreOf(a));
  if (ranked.length < 3) throw new Error("Need at least 3 scored media items to build a timeline");

  const useHook = Boolean(structure?.hook);
  // Hook opens on the best CLOSE-UP (aesthetic food/detail — the "vibe check");
  // the default structure opens on the best shot overall.
  const opening = useHook ? (ranked.find((r) => r.shot_type === "close") ?? ranked[0]) : ranked[0];
  // Prefer a photo (or a still-feeling clip) for the closing hold, so the CTA
  // text is easy to read over a calmer frame rather than mid-motion video.
  const closingCandidates = ranked.filter((r) => r.id !== opening.id && r.kind === "photo");
  const closing = closingCandidates[0] ?? ranked.find((r) => r.id !== opening.id);

  const used = new Set([opening.id, closing.id]);
  const middlePool = ranked.filter((r) => !used.has(r.id));

  // Interleave wide/close/other for visual rhythm.
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

  const openingDur = snapBeats(useHook ? HOOK_TARGET_SECONDS : OPENING_SECONDS, useHook ? 1.5 : 3.4);
  const head = [toTimelineItem(opening, "opening", openingDur)];
  let spentHead = openingDur;

  // beatcut: 3-panel splits right after the hook, middle panel = the hook shot
  // held static while top/bottom swap on the beat (the Canva collage effect).
  const split3Count = Math.max(0, structure?.split3 ?? 0);
  for (let s = 0; s < split3Count && queue.length >= 2; s++) {
    const dur = snapBeats(SPLIT3_TARGET_SECONDS);
    head.push(toSplit3Item(queue.shift(), opening, queue.shift(), dur));
    spentHead += dur;
  }

  const slice = snapBeats(targetSlice);
  const heroSlice = snapBeats(Math.min(MAX_HERO_SECONDS, targetSlice * Math.max(1, heroHold)), MAX_HERO_SECONDS);
  const bounceDur = structure?.bounceBack ? snapBeats(BOUNCE_TARGET_SECONDS, 1.0) : 0;

  const middleBudget = Math.max(0, totalDurationSeconds - spentHead - bounceDur - CLOSING_SECONDS);

  // Fill the middle greedily on the beat grid: close-ups get hero holds, and
  // 2-up split moments drop in at spaced slots while footage allows.
  const middle = [];
  let spent = 0;
  let slot = 0;
  let splitsLeft = Math.max(0, splitMoments);
  const splitSlots = new Set(splitMoments > 0 ? [2, 6, 10] : []);

  while (queue.length > 0) {
    if (splitsLeft > 0 && splitSlots.has(slot) && queue.length >= 2 && spent + slice <= middleBudget) {
      middle.push(toSplitItem(queue.shift(), queue.shift(), slice));
      spent += slice;
      splitsLeft--;
    } else {
      const row = queue[0];
      const isHero = row.shot_type === "close";
      const dur = isHero ? heroSlice : slice;
      if (spent + dur > middleBudget + 0.001) {
        if (!isHero || spent + slice > middleBudget + 0.001) break;
        // hero doesn't fit but a plain slice does — take the plain slice
        middle.push(toTimelineItem(queue.shift(), "highlight", slice));
        spent += slice;
        slot++;
        continue;
      }
      middle.push(toTimelineItem(queue.shift(), "highlight", dur));
      spent += dur;
    }
    slot++;
  }

  const tail = [];
  // Bounce-back: flash an earlier highlight again for ~1 beat before the end
  // card — matches the reference edit's double-beat ending.
  if (bounceDur > 0 && middle.length > 0) {
    const source = middle.find((m) => m.kind !== "split" && m.kind !== "split3") ?? null;
    if (source) tail.push({ ...source, role: "bounce", duration: bounceDur });
  }

  // The closing end card absorbs every non-divisible leftover second, keeping
  // all preceding cuts on the beat grid.
  const leftover = Math.max(0, middleBudget - spent);
  tail.push(toTimelineItem(closing, "closing", CLOSING_SECONDS + leftover));

  return [...head, ...middle, ...tail];
}
