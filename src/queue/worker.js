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
      let framePath = r.stored_path;
      if (r.kind === "video") {
        framePath = await extractFrame(r.stored_path, Number(r.trim_start_seconds ?? 0) + 0.5).catch(() => null);
        if (!framePath) continue;
        cleanup.push(framePath);
      }
      shots.push({ id: r.id, framePath, kind: r.kind });
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
  // real kicks (not a fixed grid). Falls back to the BPM grid if aubio can't.
  const { beats } = await detectBeats(musicTrack.file_path);

  // Let Gemini direct WHICH shots and in WHAT ORDER (opener → build → closer);
  // beats still decide the cut timing. Null → heuristic order (no regression).
  const directorPlan = await runDirector(scoredRows);
  logger.info(
    { jobId: job.id, style: style.name, beatsDetected: beats.length, director: Boolean(directorPlan) },
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
  });
  // Split-screen entries carry 2-3 media items — record all in the selection.
  const selected = timeline.flatMap((t) =>
    t.kind === "split3" ? [t.a, t.b, t.c] : t.kind === "split" ? [t.a, t.b] : [t],
  );
  await markSelection(
    project.id,
    selected.map((t, i) => ({ mediaItemId: t.mediaItemId, order: i })),
  );

  await updateStatus(job.id, "rendering");
  const outputPath = join(config.paths.renderDir, `${project.id}-${randomUUID()}.mp4`);
  await composeVideo({
    timeline,
    musicTrack,
    style,
    eventName: project.event_name,
    titleSubText: buildTitleSub(project),
    hook: directorPlan?.hook ?? null,
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
  logger.info({ jobId: job.id, outputPath }, "render complete");
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
