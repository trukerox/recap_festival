import { Router } from "express";
import { statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { httpError } from "../middleware/errorHandler.js";
import { getJob, listJobsWithProject, deleteJob } from "../repositories/renderJobs.js";

export const jobsRouter = Router();

// List all render jobs (newest first) for the Videos tab.
jobsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await listJobsWithProject());
  } catch (err) {
    next(err);
  }
});

jobsRouter.get("/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// Inline playback for the <video> element (Range-enabled via sendFile; no
// attachment disposition, so the browser plays rather than downloads).
jobsRouter.get("/:id/video", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    if (job.status !== "done" || !job.output_path) {
      throw httpError(409, `Job is not finished yet (status: ${job.status})`);
    }
    res.sendFile(resolve(process.cwd(), job.output_path), (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// Forced download (attachment).
jobsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    if (job.status !== "done" || !job.output_path) {
      throw httpError(409, `Job is not finished yet (status: ${job.status})`);
    }
    const abs = resolve(process.cwd(), job.output_path);
    statSync(abs); // 404 if missing
    res.download(abs, basename(abs));
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete("/:id", async (req, res, next) => {
  try {
    const job = await deleteJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    if (job.output_path) await unlink(resolve(process.cwd(), job.output_path)).catch(() => {});
    res.json({ ok: true, deleted: job.id });
  } catch (err) {
    next(err);
  }
});

export default jobsRouter;
