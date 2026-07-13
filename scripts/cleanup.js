// Deletes uploads/renders (and their DB rows) older than RETENTION_DAYS.
// Set RETENTION_DAYS=0 to disable. Meant to run on a daily cron (see
// deploy/update-pi.sh --install-cron).
import { unlink } from "node:fs/promises";
import config from "../src/config/index.js";
import pool, { query } from "../src/db/pool.js";
import logger from "../src/utils/logger.js";

async function cleanup() {
  if (!config.retentionDays || config.retentionDays <= 0) {
    logger.info("retention disabled (RETENTION_DAYS=0) — nothing to do");
    return;
  }

  const cutoff = `DATE_SUB(NOW(), INTERVAL ${config.retentionDays} DAY)`;

  const staleJobs = await query(
    `SELECT id, output_path FROM render_jobs WHERE finished_at IS NOT NULL AND finished_at < ${cutoff}`,
  );
  for (const job of staleJobs) {
    if (job.output_path) await unlink(job.output_path).catch(() => {});
  }

  const staleProjects = await query(
    `SELECT p.id, mi.stored_path
     FROM projects p
     JOIN media_items mi ON mi.project_id = p.id
     WHERE p.created_at < ${cutoff}`,
  );
  for (const row of staleProjects) {
    await unlink(row.stored_path).catch(() => {});
  }

  // ON DELETE CASCADE handles media_items/media_scores/render_jobs.
  const result = await query(`DELETE FROM projects WHERE created_at < ${cutoff}`);
  logger.info({ deletedProjects: result.affectedRows, deletedJobFiles: staleJobs.length }, "cleanup complete");
}

cleanup()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "cleanup failed");
    process.exit(1);
  });
