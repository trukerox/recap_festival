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
import { analyzeMediaItem } from "../services/mediaAnalysis.js";
import { buildTimeline } from "../services/selection.js";
import { composeVideo } from "../services/videoComposer.js";
import { getStyle } from "../services/styles.js";

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
  logger.info({ jobId: job.id, style: style.name }, "render style");

  const timeline = buildTimeline(scoredRows, {
    bpm: musicTrack.bpm,
    totalDurationSeconds: config.render.durationSeconds,
    targetSlice: style.targetSlice,
    closeupBias: style.closeupBias,
    heroHold: style.heroHold,
    splitMoments: style.splitMoments,
  });
  // Split-screen entries carry two media items — record both in the selection.
  const selected = timeline.flatMap((t) => (t.kind === "split" ? [t.a, t.b] : [t]));
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
    outputPath,
    onProgress: (p) => {
      // p.percent is unreliable for filter_complex graphs (ffmpeg can't always
      // predict total frames); fall back to a coarse frame-based estimate.
      const percent = Math.min(95, Math.round((p.frames ?? 0) / (config.render.durationSeconds * 30) * 100));
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
