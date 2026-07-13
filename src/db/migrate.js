// Minimal forward-only migration runner.
// Applies every src/db/migrations/NNN_*.sql not yet recorded in schema_migrations,
// in filename order, each inside its own connection. Idempotent across restarts.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./pool.js";
import logger from "../utils/logger.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function ensureTable(conn) {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version VARCHAR(255) PRIMARY KEY,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}

export async function runMigrations() {
  const conn = await pool.getConnection();
  try {
    await ensureTable(conn);
    const [applied] = await conn.query("SELECT version FROM schema_migrations");
    const done = new Set(applied.map((r) => r.version));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      logger.info({ migration: file }, "applying migration");
      // Split on ";" at line ends so multi-statement files run statement-by-statement.
      const statements = sql
        .split(/;\s*$/m)
        .map((s) => s.replace(/^(\s*--[^\n]*\n)*/g, "").trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [file]);
    }
    logger.info({ count: files.length }, "migrations up to date");
  } finally {
    conn.release();
  }
}

// Allow `node src/db/migrate.js` standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "migration failed");
      process.exit(1);
    });
}
