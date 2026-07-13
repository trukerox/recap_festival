import { query, queryOne } from "../db/pool.js";

export async function listActive(genre) {
  if (genre && genre !== "auto") {
    return query("SELECT * FROM music_tracks WHERE active = 1 AND genre = ? ORDER BY title", [genre]);
  }
  return query("SELECT * FROM music_tracks WHERE active = 1 ORDER BY genre, title");
}

export async function getById(id) {
  return queryOne("SELECT * FROM music_tracks WHERE id = ?", [id]);
}

export async function listAll() {
  return query("SELECT * FROM music_tracks ORDER BY created_at DESC");
}

// Used by both scripts/seed-music.js (bulk, from music/library.json) and the
// "add by URL" API route (one at a time) — upserts by file_path so re-adding
// the same track updates it instead of duplicating.
export async function upsertTrack(t) {
  const existing = await queryOne("SELECT id FROM music_tracks WHERE file_path = ?", [t.filePath]);
  if (existing) {
    await query(
      `UPDATE music_tracks SET title=?, artist=?, genre=?, bpm=?, duration_seconds=?,
         license=?, source_url=?, active=1 WHERE id=?`,
      [t.title, t.artist, t.genre, t.bpm, t.durationSeconds, t.license, t.sourceUrl, existing.id],
    );
    return getById(existing.id);
  }
  const result = await query(
    `INSERT INTO music_tracks (title, artist, genre, bpm, duration_seconds, file_path, license, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.title, t.artist, t.genre, t.bpm, t.durationSeconds, t.filePath, t.license, t.sourceUrl],
  );
  return getById(result.insertId);
}

export async function setActive(id, active) {
  await query("UPDATE music_tracks SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  return getById(id);
}

// Returns the deleted row (so the caller can unlink its file), or null if it
// didn't exist. render_jobs.music_track_id is ON DELETE SET NULL, so past
// jobs are unaffected.
export async function deleteById(id) {
  const track = await getById(id);
  if (!track) return null;
  await query("DELETE FROM music_tracks WHERE id = ?", [id]);
  return track;
}

// Partial update for correcting an auto-detected BPM or a misjudged genre
// after the fact — both are best-effort guesses, never presented as certain.
export async function updateFields(id, { bpm, genre } = {}) {
  const fields = [];
  const params = [];
  if (bpm != null) { fields.push("bpm = ?"); params.push(bpm); }
  if (genre != null) { fields.push("genre = ?"); params.push(genre); }
  if (fields.length === 0) return getById(id);
  params.push(id);
  await query(`UPDATE music_tracks SET ${fields.join(", ")} WHERE id = ?`, params);
  return getById(id);
}

// "auto" (or an unrecognised style) picks any active track — the festival/edm
// tracks are weighted first since they best match the brief's default mood.
export async function pickForStyle(style) {
  const preferredOrder = ["festival", "edm", "electronic", "pop", "cinematic"];
  if (style && preferredOrder.includes(style)) {
    const rows = await query(
      "SELECT * FROM music_tracks WHERE active = 1 AND genre = ? ORDER BY RAND() LIMIT 1",
      [style],
    );
    if (rows[0]) return rows[0];
  }
  for (const genre of preferredOrder) {
    const rows = await query(
      "SELECT * FROM music_tracks WHERE active = 1 AND genre = ? ORDER BY RAND() LIMIT 1",
      [genre],
    );
    if (rows[0]) return rows[0];
  }
  return queryOne("SELECT * FROM music_tracks WHERE active = 1 ORDER BY RAND() LIMIT 1");
}
