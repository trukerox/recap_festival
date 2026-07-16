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
// How long a single shot may be stretched to fill the reel WITHOUT repeating any
// shot. Only reached when very few shots are available; a long hold beats a dupe.
const MAX_FILL_SECONDS = 6.0;
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
function prepare(scoredMediaRows, { closeupBias, useHook, directorOrder }) {
  // Gemini director path: use its culled, ordered plan directly (opener → middle
  // → closer). Falls through to the heuristic below if the plan is unusable.
  if (Array.isArray(directorOrder) && directorOrder.length >= 3) {
    const byId = new Map(scoredMediaRows.map((r) => [r.id, r]));
    const picked = directorOrder.map((o) => ({ row: byId.get(o.id), role: o.role })).filter((x) => x.row);
    if (picked.length >= 3) {
      const opening = (picked.find((x) => x.role === "opener") ?? picked[0]).row;
      const closing = (picked.find((x) => x.role === "closer" && x.row.id !== opening.id) ?? picked[picked.length - 1]).row;
      const used = new Set([opening.id, closing.id]);
      const queue = picked.filter((x) => !used.has(x.row.id)).map((x) => x.row);
      return { opening, closing, queue };
    }
  }

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
  const { opening, closing, queue } = prepare(scoredMediaRows, { closeupBias, useHook, directorOrder: opts.directorOrder });

  const usableEnd = totalDurationSeconds - MIN_ENDCARD_SECONDS;
  // Beat times inside the content window, ascending.
  const B = beats.filter((t) => t > 0.05 && t <= usableEnd).sort((a, b) => a - b);
  if (B.length < 4) return null; // not enough beats in-window — fall back to grid

  const gaps = B.slice(1).map((t, i) => t - B[i]).filter((g) => g > 0.05);
  const medianGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0.5;
  const beatsFor = (seconds) => Math.max(1, Math.round(seconds / medianGap));

  // aubio's beats often peter out partway through a track (quiet section, or it
  // simply stops locking on). If we only cut on the detected beats, the edit
  // stops there and the closing shot freezes for the whole remaining time (the
  // "stuck on one clip" bug). Extend the beat grid on the median tempo up to the
  // end-card window so cuts keep landing to the end.
  for (let t = B[B.length - 1] + medianGap; t <= usableEnd; t += medianGap) {
    B.push(Number(t.toFixed(4)));
  }

  const split3Advance = beatsFor(SPLIT3_TARGET_SECONDS);

  // First cut: the first beat at/after the opening target, so the opening
  // (title/hook) plays over the intro and the first cut lands on a real beat.
  const openingTarget = useHook ? HOOK_TARGET_SECONDS : OPENING_SECONDS;
  let idx = B.findIndex((t) => t >= openingTarget);
  if (idx < 0) idx = B.length - 1;

  const head = [toTimelineItem(opening, "opening", B[idx])]; // 0 -> first beat
  const seq = [];

  // beatcut: 3-panel stacked split. All three panels are now DISTINCT shots —
  // the middle panel used to re-use the opening shot, a visible duplicate.
  let split3Left = Math.max(0, structure?.split3 ?? 0);
  while (split3Left > 0 && queue.length >= 3 && idx + split3Advance < B.length) {
    const next = idx + split3Advance;
    if (B[next] > usableEnd) break;
    seq.push(toSplit3Item(queue.shift(), queue.shift(), queue.shift(), B[next] - B[idx]));
    idx = next;
    split3Left--;
  }

  // THE DROP: the beat where the music's sustained energy jumps (detected by
  // the aubio sidecar). RESERVE the strongest shot for it UP FRONT — the
  // director's slow-mo video if one is queued, else the highest-scored shot.
  // Reserving matters: picking "best remaining" at the drop doesn't work,
  // because the best shot is usually consumed by the queue before the drop
  // arrives (mock-test proved it).
  const preferAtDrop = Array.isArray(opts.preferAtDrop) ? opts.preferAtDrop : [];
  const dropAt = Number.isFinite(opts.drop) && opts.drop > B[idx] && opts.drop <= usableEnd ? opts.drop : null;
  let reserved = null;
  if (dropAt != null && queue.length > 1) {
    let bi = queue.findIndex((r) => preferAtDrop.includes(r.id));
    if (bi < 0) {
      bi = 0;
      for (let i = 1; i < queue.length; i++) {
        if ((queue[i].composite_score ?? 0) > (queue[bi].composite_score ?? 0)) bi = i;
      }
    }
    reserved = queue.splice(bi, 1)[0];
  }

  // NO REPEATS. Pace the remaining cuts so the shots we still have fill the
  // window exactly — one shot, one slot, nothing shown twice. We used to RECYCLE
  // the pool when it ran dry (to avoid the closing shot freezing), and that's
  // what put the same photo on screen more than once. Instead the slice now
  // STRETCHES when shots are scarce; when the style's pace is slower than needed
  // we simply use fewer shots. Either way no shot is ever repeated.
  const splitCount = Math.max(0, splitMoments);
  const remainingSegments = Math.max(1, queue.length + (reserved ? 1 : 0) - splitCount); // a 2-up split eats 1 extra shot
  const remainingWindow = Math.max(0.1, usableEnd - B[idx]);
  // Work in BEATS (cuts must land on them). Round the fill pace UP so the shots
  // we have cover the window — rounding down would run out early and leave the
  // end card holding the slack. Never cut faster than the style wants, and never
  // stretch a shot past MAX_FILL_SECONDS.
  const minAdvance = beatsFor(targetSlice);
  const fillAdvance = Math.max(1, Math.ceil(remainingWindow / (remainingSegments * medianGap)));
  const maxAdvance = beatsFor(MAX_FILL_SECONDS);
  const normalAdvance = Math.min(maxAdvance, Math.max(minAdvance, fillAdvance));
  const effSlice = normalAdvance * medianGap;
  const heroAdvance = Math.max(normalAdvance, beatsFor(Math.min(MAX_HERO_SECONDS, effSlice * Math.max(1, heroHold))));

  // PACING CURVE ("the breath"): uniform cutting frequency reads amateur. When
  // a drop exists: up to 3 cuts ACCELERATE into it (double-time, building with
  // the music), the boundary before the payoff is SHORTENED so it lands exactly
  // ON the drop beat, and the payoff shot then HOLDS long so the viewer can
  // breathe before normal pacing resumes. Acceleration is skipped when the pool
  // is already being stretched to fill (effSlice > MAX_SLICE) or shallow (≤4) —
  // it would drain the queue and dump the slack onto the end card.
  const accelAdvance = Math.max(1, Math.ceil(normalAdvance / 2));
  const breathAdvance = Math.max(heroAdvance, beatsFor(Math.min(MAX_HERO_SECONDS, effSlice * 1.8)));
  let accelLeft = 3;
  let dropBeatIdx = -1;
  if (dropAt != null) {
    dropBeatIdx = 0;
    for (let i = 1; i < B.length; i++) if (Math.abs(B[i] - dropAt) < Math.abs(B[dropBeatIdx] - dropAt)) dropBeatIdx = i;
  }

  let splitsLeft = splitCount;
  const splitSlots = new Set(splitCount > 0 ? [2, 6, 10] : []);
  let slot = 0;
  while (idx < B.length && (queue.length > 0 || reserved)) {
    // Release the reserved shot on the first segment starting at/after the drop
    // (within half a beat, so a hero hold overshooting slightly still counts) —
    // or immediately if the queue ran dry early, so it's never lost.
    const dropNow = Boolean(reserved) && (B[idx] >= dropAt - medianGap / 2 || queue.length === 0);
    if (dropNow) {
      queue.unshift(reserved);
      reserved = null;
    }
    const toDrop = reserved && dropBeatIdx > idx ? dropBeatIdx - idx : Infinity;
    const nearDrop = toDrop <= 3 * normalAdvance; // inside the build-up window
    if (!dropNow && !nearDrop && splitsLeft > 0 && splitSlots.has(slot) && queue.length >= 2) {
      const next = idx + normalAdvance;
      if (next >= B.length || B[next] > usableEnd) break;
      seq.push(toSplitItem(queue.shift(), queue.shift(), B[next] - B[idx]));
      idx = next;
      splitsLeft--;
    } else {
      const row = queue[0];
      let advance = row.shot_type === "close" ? heroAdvance : normalAdvance;
      if (dropNow) {
        advance = breathAdvance; // the payoff holds — breathe
      } else if (nearDrop) {
        if (accelLeft > 0 && queue.length > 4 && effSlice <= MAX_SLICE_SECONDS) {
          advance = Math.min(accelAdvance, toDrop); // double-time, never past the drop
          accelLeft--;
        } else {
          advance = Math.min(advance, toDrop); // shorten to land exactly ON the drop
        }
      }
      let next = idx + advance;
      if (next >= B.length || B[next] > usableEnd) {
        // Pool ran out just short of the window: stretch the LAST shot to the
        // end-card boundary (within MAX_FILL) instead of leaving a long card.
        const last = B.length - 1;
        if (queue.length === 1 && last > idx && B[last] - B[idx] <= MAX_FILL_SECONDS) next = last;
        else break;
      }
      seq.push(toTimelineItem(queue.shift(), "highlight", B[next] - B[idx]));
      idx = next;
    }
    slot++;
  }

  // (Bounce-back removed: it deliberately re-showed an earlier shot.)

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
  const { opening, closing, queue } = prepare(scoredMediaRows, { closeupBias, useHook: false, directorOrder: opts.directorOrder });

  const budget = Math.max(0, totalDurationSeconds - OPENING_SECONDS - CLOSING_SECONDS);
  // NO REPEATS (see the beat path): stretch the slice so the shots we have fill
  // the budget, rather than recycling the pool and showing a shot twice.
  const splitCount = Math.max(0, splitMoments);
  const segments = Math.max(1, queue.length - splitCount);
  const effTarget = Math.max(MIN_SLICE_SECONDS, Math.min(MAX_FILL_SECONDS, Math.max(targetSlice, budget / segments)));
  const slice = snap(effTarget, MAX_FILL_SECONDS);
  const heroSlice = snap(Math.min(MAX_HERO_SECONDS, effTarget * Math.max(1, heroHold)), MAX_HERO_SECONDS);
  const middle = [];
  let spent = 0, slot = 0, splitsLeft = splitCount;
  const splitSlots = new Set(splitCount > 0 ? [2, 6, 10] : []);
  while (spent < budget - 0.001 && queue.length > 0) {
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
    directorOrder = null,
    drop = null,
    preferAtDrop = [],
  },
) {
  const opts = { beats, bpm, totalDurationSeconds, targetSlice, closeupBias, heroHold, splitMoments, structure, directorOrder, drop, preferAtDrop };
  if (Array.isArray(beats) && beats.length >= 8) {
    const beatTimeline = buildBeatTimeline(scoredMediaRows, opts);
    if (beatTimeline && beatTimeline.length >= 3) return beatTimeline;
  }
  return buildGridTimeline(scoredMediaRows, opts);
}
