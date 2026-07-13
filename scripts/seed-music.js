// Loads music/library.json into the music_tracks table. Idempotent: matches
// existing rows by file_path and updates them instead of duplicating.
// Usage: node scripts/seed-music.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../src/db/pool.js";
import { upsertTrack, listAll } from "../src/repositories/musicTracks.js";
import logger from "../src/utils/logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY_PATH = join(ROOT, "music", "library.json");

async function seed() {
  const tracks = JSON.parse(readFileSync(LIBRARY_PATH, "utf8"));
  const before = await listAll();
  const beforeIds = new Set(before.map((t) => t.id));
  let count = 0;

  for (const t of tracks) {
    if (t.title?.startsWith("REPLACE_ME")) continue; // skip the template entry
    await upsertTrack({
      title: t.title,
      artist: t.artist,
      genre: t.genre,
      bpm: t.bpm,
      durationSeconds: t.duration_seconds,
      filePath: t.file_path,
      license: t.license,
      sourceUrl: t.source_url,
    });
    count++;
  }

  const after = await listAll();
  const inserted = after.filter((t) => !beforeIds.has(t.id)).length;
  logger.info({ processed: count, inserted, updated: count - inserted }, "music library seeded");
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "seed-music failed");
    process.exit(1);
  });
