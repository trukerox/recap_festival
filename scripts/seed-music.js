// Loads music/library.json into the music_tracks table. Idempotent: matches
// existing rows by file_path and updates them instead of duplicating.
// Usage: node scripts/seed-music.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pool, { query, queryOne } from "../src/db/pool.js";
import logger from "../src/utils/logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY_PATH = join(ROOT, "music", "library.json");

async function seed() {
  const tracks = JSON.parse(readFileSync(LIBRARY_PATH, "utf8"));
  let inserted = 0;
  let updated = 0;

  for (const t of tracks) {
    if (t.title?.startsWith("REPLACE_ME")) continue; // skip the template entry
    const existing = await queryOne("SELECT id FROM music_tracks WHERE file_path = ?", [t.file_path]);
    if (existing) {
      await query(
        `UPDATE music_tracks SET title=?, artist=?, genre=?, bpm=?, duration_seconds=?,
           license=?, source_url=?, active=1 WHERE id=?`,
        [t.title, t.artist, t.genre, t.bpm, t.duration_seconds, t.license, t.source_url, existing.id],
      );
      updated++;
    } else {
      await query(
        `INSERT INTO music_tracks (title, artist, genre, bpm, duration_seconds, file_path, license, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.title, t.artist, t.genre, t.bpm, t.duration_seconds, t.file_path, t.license, t.source_url],
      );
      inserted++;
    }
  }

  logger.info({ inserted, updated }, "music library seeded");
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "seed-music failed");
    process.exit(1);
  });
