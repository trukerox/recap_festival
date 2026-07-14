import { query, queryOne } from "../db/pool.js";

export async function createJob({ projectId, musicTrackId, style = null }) {
  const result = await query(
    "INSERT INTO render_jobs (project_id, music_track_id, style, status) VALUES (?, ?, ?, 'queued')",
    [projectId, musicTrackId ?? null, style],
  );
  return getJob(result.insertId);
}

export async function getJob(id) {
  return queryOne("SELECT * FROM render_jobs WHERE id = ?", [id]);
}

// Atomically claims the oldest queued job so a single worker never double-picks
// (defensive — RENDER_CONCURRENCY is 1 by default, but this is cheap insurance
// if it's ever raised or a second worker process is started).
export async function claimNextQueuedJob() {
  const candidate = await queryOne(
    "SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1",
  );
  if (!candidate) return null;

  const result = await query(
    "UPDATE render_jobs SET status = 'analyzing', started_at = NOW() WHERE id = ? AND status = 'queued'",
    [candidate.id],
  );
  if (result.affectedRows === 0) return null; // lost the race to another worker
  return getJob(candidate.id);
}

export async function updateStatus(id, status, extra = {}) {
  const fields = ["status = ?"];
  const params = [status];
  for (const [col, val] of Object.entries(extra)) {
    fields.push(`${col} = ?`);
    params.push(val);
  }
  params.push(id);
  await query(`UPDATE render_jobs SET ${fields.join(", ")} WHERE id = ?`, params);
  return getJob(id);
}

export async function markProgress(id, percent) {
  await query("UPDATE render_jobs SET progress_percent = ? WHERE id = ?", [percent, id]);
}

export async function markDone(id, outputPath) {
  await query(
    "UPDATE render_jobs SET status = 'done', progress_percent = 100, output_path = ?, finished_at = NOW() WHERE id = ?",
    [outputPath, id],
  );
  return getJob(id);
}

export async function markFailed(id, errorMessage) {
  await query(
    "UPDATE render_jobs SET status = 'failed', error_message = ?, finished_at = NOW() WHERE id = ?",
    [String(errorMessage).slice(0, 2000), id],
  );
  return getJob(id);
}

// For the Videos tab: every job with its project's event name, newest first.
// NB: LIMIT is inlined as a sanitized integer, not a bound `?` — mysql2's
// prepared statements reject `LIMIT ?` ("Incorrect arguments to
// mysqld_stmt_execute"). Safe because `lim` is clamped to an integer here.
export async function listJobsWithProject(limit = 100) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return query(
    `SELECT j.*, p.event_name
     FROM render_jobs j
     LEFT JOIN projects p ON p.id = j.project_id
     ORDER BY j.queued_at DESC
     LIMIT ${lim}`,
  );
}

export async function deleteJob(id) {
  const job = await getJob(id);
  if (!job) return null;
  await query("DELETE FROM render_jobs WHERE id = ?", [id]);
  return job;
}
