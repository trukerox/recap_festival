// Turns scored media into the recap timeline.
//
// AUDIO-SYNC IS LAW. When actual beat timestamps are available (aubio, via
// bpmDetect.detectBeats), every cut is placed ON a real detected beat — so the
// edit hits the real kicks, accounting for the song's intro and any drift.
// (The older BPM-grid path — cuts at multiples of 60/bpm from t=0 — is kept as
// a fallback but is inferior: it ignores where the beats actually are.)
//
// Structure per style (style.structure):
//   default: strong opening → beat-cut highlights (hero holds on close-ups,
//            optional 2-up splits) → branded end card
//   beatcut: ~1 beat-region hook (close-up under the title) → 3-panel stacked
//            splits (middle = the hook shot, top/bottom swap on the beat) →
//            rapid full-screen cuts → 0.5s bounce-back → end card
const OPENING_SECONDS = 3;
const CLOSING_SECONDS = 3;
const MIN_ENDCARD_SECONDS = 2.5;
const MIN_SLICE_SECONDS = 0.7;
const MAX_SLICE_SECONDS = 2.6;
const MAX_HERO_SECONDS = 2.8;
const DEFAULT_TARGET_SLICE = 1.5;
const HOOK_TARGET_SECONDS = 1.0;
const SPLIT3_TARGET_SECONDS = 1.2;

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
    trimStart: isVideo ? Number(row.trim_start_seconds ?? 0) : null,
    trimEnd: isVideo ? Number(row.trim_start_seconds ?? 0) + duration : null,
  };
}

function toSplitItem(rowA, rowB, duration) {
  return {
    kind: "split",
    role: "highlight",
    duration,
    a: toTimelineItem(rowA, "split-panel", duration),
    b: toTimelineItem(rowB, "split-panel", duration),
  };
}

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

// Rank media, apply the style's close-up bias, and split into an interleaved
// wide/close/other play queue + the opening & closing picks. Shared by both
// the beat-driven and grid builders.
function prepare(scoredMediaRows, { closeupBias, useHook }) {
  const scoreOf = (r) => (r.composite_score ?? 0) * (r.shot_type === "close" ? closeupBias : 1);
  const ranked = [...scoredMediaRows].sort((a, b) => scoreOf(b) - scoreOf(a));
  if (ranked.length < 3) throw new Error("Need at least 3 scored media items to build a timeline");

  const opening = useHook ? (ranked.find((r) => r.shot_type === "close") ?? ranked[0]) : ranked[0];
  const closingCandidates = ranked.filter((r) => r.id !== opening.id && r.kind === "photo");
  const closing = closingCandidates[0] ?? ranked.find((r) => r.id !== opening.id);

  const used = new Set([opening.id, closing.id]);
  const pool = ranked.filter((r) => !used.has(r.id));
  const wide = pool.filter((r) => r.shot_type === "wide");
  const close = pool.filter((r) => r.shot_type === "close");
  const other = pool.filter((r) => r.shot_type !== "wide" && r.shot_type !== "close");
  const queue = [];
  let wi = 0, ci = 0, oi = 0;
  while (wi < wide.length || ci < close.length || oi < other.length) {
    if (wi < wide.length) queue.push(wide[wi++]);
    if (ci < close.length) queue.push(close[ci++]);
    if (oi < other.length) queue.push(other[oi++]);
  }
  return { opening, closing, queue };
}

// The real fix: place every cut on an actual detected beat.
function buildBeatTimeline(scoredMediaRows, opts) {
  const { beats, totalDurationSeconds, targetSlice, closeupBias, heroHold, splitMoments, structure } = opts;
  const useHook = Boolean(structure?.hook);
  const { opening, closing, queue } = prepare(scoredMediaRows, { closeupBias, useHook });

  const usableEnd = totalDurationSeconds - MIN_ENDCARD_SECONDS;
  // Beat times inside the content window, ascending.
  const B = beats.filter((t) => t > 0.05 && t <= usableEnd).sort((a, b) => a - b);
  if (B.length < 4) return null; // not enough beats in-window — fall back to grid

  const gaps = B.slice(1).map((t, i) => t - B[i]).filter((g) => g > 0.05);
  const medianGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0.5;
  const beatsFor = (seconds) => Math.max(1, Math.round(seconds / medianGap));

  const normalAdvance = beatsFor(targetSlice);
  const heroAdvance = Math.max(normalAdvance, beatsFor(Math.min(MAX_HERO_SECONDS, targetSlice * Math.max(1, heroHold))));
  const split3Advance = beatsFor(SPLIT3_TARGET_SECONDS);
  const bounceAdvance = 1;

  // First cut: the first beat at/after the opening target, so the opening
  // (title/hook) plays over the intro and the first cut lands on a real beat.
  const openingTarget = useHook ? HOOK_TARGET_SECONDS : OPENING_SECONDS;
  let idx = B.findIndex((t) => t >= openingTarget);
  if (idx < 0) idx = B.length - 1;

  const head = [toTimelineItem(opening, "opening", B[idx])]; // 0 -> first beat
  const seq = [];

  // beatcut: 3-panel splits right after the hook (middle stays the hook shot).
  let split3Left = Math.max(0, structure?.split3 ?? 0);
  while (split3Left > 0 && queue.length >= 2 && idx + split3Advance < B.length) {
    const next = idx + split3Advance;
    if (B[next] > usableEnd) break;
    seq.push(toSplit3Item(queue.shift(), opening, queue.shift(), B[next] - B[idx]));
    idx = next;
    split3Left--;
  }

  // Middle: advance beat-by-beat, cutting on real beats. Close-ups are held
  // for more beats (hero); 2-up split moments drop in at spaced slots.
  let splitsLeft = Math.max(0, splitMoments);
  const splitSlots = new Set(splitMoments > 0 ? [2, 6, 10] : []);
  let slot = 0;
  while (queue.length > 0) {
    if (splitsLeft > 0 && splitSlots.has(slot) && queue.length >= 2) {
      const next = idx + normalAdvance;
      if (next >= B.length || B[next] > usableEnd) break;
      seq.push(toSplitItem(queue.shift(), queue.shift(), B[next] - B[idx]));
      idx = next;
      splitsLeft--;
    } else {
      const row = queue[0];
      const advance = row.shot_type === "close" ? heroAdvance : normalAdvance;
      const next = idx + advance;
      if (next >= B.length || B[next] > usableEnd) break;
      seq.push(toTimelineItem(queue.shift(), "highlight", B[next] - B[idx]));
      idx = next;
    }
    slot++;
  }

  // Bounce-back: flash an earlier highlight again for one beat before the card.
  if (structure?.bounceBack && seq.length > 0 && idx + bounceAdvance < B.length && B[idx + bounceAdvance] <= usableEnd) {
    const source = seq.find((s) => s.kind !== "split" && s.kind !== "split3");
    if (source) {
      const next = idx + bounceAdvance;
      seq.push({ ...source, role: "bounce", duration: B[next] - B[idx] });
      idx = next;
    }
  }

  // End card starts on the last cut beat and runs to the target end — so even
  // the cut INTO the branded card lands on a beat.
  const closingDur = totalDurationSeconds - B[idx];
  return [...head, ...seq, toTimelineItem(closing, "closing", closingDur)];
}

// Fallback when no beats are available: snap durations to the BPM grid.
function buildGridTimeline(scoredMediaRows, opts) {
  const { bpm, totalDurationSeconds, targetSlice, closeupBias, heroHold, splitMoments } = opts;
  const beat = bpm ? 60 / bpm : null;
  const snap = (s, max = MAX_SLICE_SECONDS) => {
    if (!beat) return Math.min(s, max);
    let n = Math.max(1, Math.round(s / beat));
    while (n > 1 && n * beat > max) n--;
    return n * beat;
  };
  const { opening, closing, queue } = prepare(scoredMediaRows, { closeupBias, useHook: false });

  const slice = snap(targetSlice);
  const heroSlice = snap(Math.min(MAX_HERO_SECONDS, targetSlice * Math.max(1, heroHold)), MAX_HERO_SECONDS);
  const budget = Math.max(0, totalDurationSeconds - OPENING_SECONDS - CLOSING_SECONDS);
  const middle = [];
  let spent = 0, slot = 0, splitsLeft = Math.max(0, splitMoments);
  const splitSlots = new Set(splitMoments > 0 ? [2, 6, 10] : []);
  while (queue.length > 0) {
    if (splitsLeft > 0 && splitSlots.has(slot) && queue.length >= 2 && spent + slice <= budget) {
      middle.push(toSplitItem(queue.shift(), queue.shift(), slice));
      spent += slice; splitsLeft--;
    } else {
      const row = queue[0];
      const dur = row.shot_type === "close" ? heroSlice : slice;
      if (spent + dur > budget + 0.001) break;
      middle.push(toTimelineItem(queue.shift(), "highlight", dur));
      spent += dur;
    }
    slot++;
  }
  const leftover = Math.max(0, budget - spent);
  return [
    toTimelineItem(opening, "opening", OPENING_SECONDS),
    ...middle,
    toTimelineItem(closing, "closing", CLOSING_SECONDS + leftover),
  ];
}

export function buildTimeline(
  scoredMediaRows,
  {
    beats = [],
    bpm,
    totalDurationSeconds,
    targetSlice = DEFAULT_TARGET_SLICE,
    closeupBias = 1,
    heroHold = 1,
    splitMoments = 0,
    structure = null,
  },
) {
  const opts = { beats, bpm, totalDurationSeconds, targetSlice, closeupBias, heroHold, splitMoments, structure };
  if (Array.isArray(beats) && beats.length >= 8) {
    const beatTimeline = buildBeatTimeline(scoredMediaRows, opts);
    if (beatTimeline && beatTimeline.length >= 3) return beatTimeline;
  }
  return buildGridTimeline(scoredMediaRows, opts);
}
