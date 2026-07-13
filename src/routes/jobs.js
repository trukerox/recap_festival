import { Router } from "express";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { httpError } from "../middleware/errorHandler.js";
import { getJob } from "../repositories/renderJobs.js";

export const jobsRouter = Router();

jobsRouter.get("/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

jobsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) throw httpError(404, "Job not found");
    if (job.status !== "done" || !job.output_path) {
      throw httpError(409, `Job is not finished yet (status: ${job.status})`);
    }
    const stat = statSync(job.output_path);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${basename(job.output_path)}"`);
    createReadStream(job.output_path).pipe(res);
  } catch (err) {
    next(err);
  }
});

export default jobsRouter;
