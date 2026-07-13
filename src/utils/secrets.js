// Reads a secret from a Docker secret file, falling back to an env var.
//
// Resolution order for a name like "db_password":
//   1) env DB_PASSWORD_FILE  → read that file
//   2) /run/secrets/db_password  (Docker secret mount inside the container)
//   3) ./secrets/db_password.txt (local dev / bind)
//   4) env DB_PASSWORD       → use the literal value (dev convenience only)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOCAL_DIR = join(process.cwd(), "secrets");

export function readSecret(name, { required = false } = {}) {
  const envKey = name.toUpperCase();
  const candidates = [];

  if (process.env[`${envKey}_FILE`]) candidates.push(process.env[`${envKey}_FILE`]);
  candidates.push(`/run/secrets/${name}`);
  candidates.push(join(LOCAL_DIR, `${name}.txt`));

  for (const path of candidates) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  }

  if (process.env[envKey]) return process.env[envKey].trim();

  if (required) {
    throw new Error(`Missing required secret "${name}" (looked in ${candidates.join(", ")} and env ${envKey})`);
  }
  return "";
}
