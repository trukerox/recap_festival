// DB-backed job queue: no Redis/BullMQ. FFmpeg rendering is CPU-bound on a
// single Pi, so a distributed queue buys nothing — a plain poll loop over
// render_jobs (status='queued') with RENDER_CONCURRENCY=1 is simpler to
// operate and matches this project's job_search-style lean self-hosted
// conventions. See docker-compose.yml header for the rationale.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { getProject } from "../repositories/projects.js";
import { listByProject } from "../repositories/mediaItems.js";
import { getScore, listScoresForProject, markSelection } from "../repositories/mediaScores.js";
import { claimNextQueuedJob, updateStatus, markProgress, markDone, markFailed } from "../repositories/renderJobs.js";
import { getById as getMusicTrack } from "../repositories/musicTracks.js";
import { unlink } from "node:fs/promises";
import { detectBeats } from "../services/bpmDetect.js";
import { analyzeMediaItem } from "../services/mediaAnalysis.js";
import { extractFrame } from "../services/frameExtract.js";
import { directEdit } from "../services/geminiDirector.js";
import { notifyRenderDone, notifyRenderFailed } from "../services/notify.js";
import { buildTimeline } from "../services/selection.js";
import { composeVideo } from "../services/videoComposer.js";
import { getStyle } from "../services/styles.js";

// Gemini director: cull + order the shots (opener → build → closer) and get a
// hook line. Best-effort — returns null (heuristic order) on any failure.
async function runDirector(scoredRows) {
  const cleanup = [];
  try {
    const shots = [];
    for (const r of scoredRows) {
      const framePaths = [];
      if (r.kind === "video") {
        // Lightweight "proxy": start → action peak → end frames, so the director
        // judges the clip's actual motion (and can pick slowmo) instead of one
        // frame. Short clips get just the peak.
        const dur = Number(r.duration_seconds ?? 0);
        const peak = Math.min(Math.max(0.3, Number(r.trim_start_seconds ?? 0) + 0.5), Math.max(0.3, dur - 0.3));
        const times = dur > 4 ? [...new Set([0.3, peak, Math.max(0.3, dur - 0.5)])] : [peak];
        for (const t of times) {
          const f = await extractFrame(r.stored_path, t).catch(() => null);
          if (f) { framePaths.push(f); cleanup.push(f); }
        }
        if (!framePaths.length) continue;
      } else {
        framePaths.push(r.stored_path);
      }
      shots.push({ id: r.id, framePaths, kind: r.kind, durationSeconds: Number(r.duration_seconds ?? 0) });
    }
    return await directEdit(shots, { durationSeconds: config.render.durationSeconds });
  } catch (err) {
    logger.warn({ err: err.message }, "director failed — using heuristic order");
    return null;
  } finally {
    for (const f of cleanup) await unlink(f).catch(() => {});
  }
}

// "HH:MM:SS.xx" -> seconds (null if unparseable).
function timemarkToSeconds(mark) {
  if (typeof mark !== "string") return null;
  const m = mark.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function analyzeProjectMedia(projectId) {
  const items = await listByProject(projectId);
  for (const item of items) {
    const existing = await getScore(item.id);
    if (existing) continue;
    try {
      await analyzeMediaItem(item);
    } catch (err) {
      // Don't let one unreadable/odd file fail the whole render — it just
      // won't get a score row, so it's excluded from selection. buildTimeline
      // will still fail loudly if too few items survive (<3).
      logger.warn({ err, mediaItemId: item.id, path: item.stored_path }, "media analysis failed; skipping item");
    }
  }
}

// Subtitle under the big "FESTIVAL RECAP" heading: event name, then location.
function buildTitleSub(project) {
  const parts = [project.event_name];
  if (project.location) parts.push(project.location);
  return parts.join("\n");
}

async function processJob(job) {
  const startedMs = Date.now();
  const project = await getProject(job.project_id);
  if (!project) throw new Error(`Project ${job.project_id} not found`);

  await updateStatus(job.id, "analyzing");
  await analyzeProjectMedia(project.id);

  await updateStatus(job.id, "selecting");
  const scoredRows = await listScoresForProject(project.id);
  const musicTrack = await getMusicTrack(job.music_track_id);
  if (!musicTrack) throw new Error(`Music track ${job.music_track_id} not found`);

  const style = getStyle(job.style);

  // Detect the ACTUAL beat timestamps in the chosen track so cuts land on the
  // real kicks (not a fixed grid), plus per-beat energy and the DROP — the
  // musical payoff beat. Falls back to the BPM grid if aubio can't.
  const { beats, energies, drop } = await detectBeats(musicTrack.file_path);

  // Let Gemini direct WHICH shots and in WHAT ORDER (opener → build → closer);
  // beats still decide the cut timing. Null → heuristic order (no regression).
  const directorPlan = await runDirector(scoredRows);
  logger.info(
    { jobId: job.id, style: style.name, beatsDetected: beats.length, drop, director: Boolean(directorPlan) },
    "render style",
  );

  const timeline = buildTimeline(scoredRows, {
    beats,
    bpm: musicTrack.bpm,
    totalDurationSeconds: config.render.durationSeconds,
    targetSlice: style.targetSlice,
    closeupBias: style.closeupBias,
    heroHold: style.heroHold,
    splitMoments: style.splitMoments,
    structure: style.structure ?? null,
    directorOrder: directorPlan?.order ?? null,
    drop,
    // The drop shot should be the director's slow-mo pick when there is one.
    preferAtDrop: Object.keys(directorPlan?.effects ?? {}).map(Number),
  });
  // Director-marked slow-mo: half-speed playback on the chosen video moments.
  // Full-screen segments only — a slowed clip inside a split panel just reads
  // as a stutter next to its normal-speed neighbours.
  if (directorPlan?.effects) {
    for (const t of timeline) {
      if (t.kind === "video" && directorPlan.effects[t.mediaItemId] === "slowmo") t.speed = 0.5;
    }
  }

  // Split-screen entries carry 2-3 media items — record all in the selection.
  const selected = timeline.flatMap((t) =>
    t.kind === "split3" ? [t.a, t.b, t.c] : t.kind === "split" ? [t.a, t.b] : [t],
  );
  await markSelection(
    project.id,
    selected.map((t, i) => ({ mediaItemId: t.mediaItemId, order: i })),
  );

  // Music energy at each segment boundary (where transitions resolve), so the
  // composer can keep the flashy transitions to the hot stretches and cut
  // quietly through the calm ones. Boundary k = end of segment k, which is a
  // beat by construction — look up the nearest beat's energy.
  const energyAt = (t) => {
    if (!energies.length) return null;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const d = Math.abs(beats[i] - t);
      if (d < bd) { bd = d; bi = i; }
    }
    return energies[bi];
  };
  const boundaryEnergies = [];
  let cum = 0;
  for (let k = 0; k < timeline.length - 1; k++) {
    cum += timeline[k].duration;
    boundaryEnergies.push(energyAt(cum));
  }

  await updateStatus(job.id, "rendering");
  const outputPath = join(config.paths.renderDir, `${project.id}-${randomUUID()}.mp4`);
  await composeVideo({
    timeline,
    musicTrack,
    style,
    eventName: project.event_name,
    titleSubText: buildTitleSub(project),
    hook: directorPlan?.hook ?? null,
    mood: directorPlan?.mood ?? null,
    boundaryEnergies,
    drop,
    outputPath,
    onProgress: (p) => {
      // Estimate from output time processed (timemark "HH:MM:SS.xx"), which
      // climbs more steadily than the frame count for nested-xfade graphs.
      // Still approximate — ffmpeg emits progress in bursts — so the UI shows
      // elapsed time + a "jumps near the end" note rather than trusting this %.
      const secs = timemarkToSeconds(p.timemark);
      const est = secs != null ? secs / config.render.durationSeconds : (p.frames ?? 0) / (config.render.durationSeconds * 30);
      const percent = Math.min(95, Math.round(est * 100));
      if (percent > 0) markProgress(job.id, percent).catch(() => {});
    },
  });

  await markDone(job.id, outputPath);
  const seconds = Math.round((Date.now() - startedMs) / 1000);
  logger.info({ jobId: job.id, outputPath, seconds }, "render complete");
  // Fire-and-forget: a notification must never delay or fail a finished render.
  notifyRenderDone({ jobId: job.id, eventName: project.event_name, style: style.name, seconds }).catch(() => {});
}

export function startWorkerLoop() {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const job = await claimNextQueuedJob();
      if (job) {
        logger.info({ jobId: job.id, projectId: job.project_id }, "claimed render job");
        try {
          await processJob(job);
        } catch (err) {
          logger.error({ err, jobId: job.id }, "render job failed");
          await markFailed(job.id, err.message).catch(() => {});
          // Worth a ping too — a failure you don't hear about is worse than one
          // you do. Best-effort, never rethrows.
          notifyRenderFailed({ jobId: job.id, error: err.message }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "worker tick failed");
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(tick, config.render.queuePollMs);
  tick(); // don't wait for the first poll interval on startup

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
