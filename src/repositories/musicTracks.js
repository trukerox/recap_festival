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
