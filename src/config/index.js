// Centralised, typed-ish config. Reads non-secret values from env and secrets
// from Docker secret files. Imported once; fail fast on missing required values.
import "dotenv/config";
import { readSecret } from "../utils/secrets.js";

const int = (v, d) => (v == null || v === "" ? d : Number.parseInt(v, 10));

const isProd = process.env.NODE_ENV === "production";

export const config = {
  env: process.env.NODE_ENV || "development",
  isProd,
  port: int(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",

  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "festival_recap",
    database: process.env.DB_NAME || "festival_recap",
    password: readSecret("db_password", { required: isProd }),
  },

  auth: {
    // Signs time-limited download links for rendered videos.
    jwtSecret: readSecret("jwt_secret", { required: isProd }) || "dev-insecure-secret-change-me",
  },

  paths: {
    dataDir: process.env.DATA_DIR || "./data",
    uploadDir: process.env.UPLOAD_DIR || "./data/uploads",
    renderDir: process.env.RENDER_DIR || "./data/renders",
    tmpDir: process.env.TMP_DIR || "./data/tmp",
    musicDir: process.env.MUSIC_DIR || "./music",
    // Reference clips (e.g. Canva examples) uploaded to study editing style —
    // not part of any render, just stored + played back in the Videos tab.
    referenceDir: process.env.REFERENCE_DIR || "./data/reference",
  },

  upload: {
    maxFiles: int(process.env.MAX_UPLOAD_FILES, 40),
    maxFileMb: int(process.env.MAX_UPLOAD_FILE_MB, 100),
    maxTotalMb: int(process.env.MAX_UPLOAD_TOTAL_MB, 1000),
  },

  render: {
    concurrency: int(process.env.RENDER_CONCURRENCY, 1),
    width: int(process.env.RENDER_WIDTH, 1080),
    height: int(process.env.RENDER_HEIGHT, 1920),
    durationSeconds: int(process.env.RENDER_DURATION_SECONDS, 20),
    queuePollMs: int(process.env.RENDER_QUEUE_POLL_MS, 3000),
    ffmpegPreset: process.env.FFMPEG_PRESET || "veryfast",
  },

  retentionDays: int(process.env.RETENTION_DAYS, 14),

  notify: {
    // Optional Telegram "render done" ping. Both come from Docker secrets; with
    // either missing, notifications are simply off (renders are unaffected).
    telegramToken: readSecret("telegram_bot_token", { required: false }) || null,
    telegramChatId: readSecret("telegram_chat_id", { required: false }) || null,
  },

  ai: {
    // Optional Gemini vision for smarter shot selection (Phase 2). With no key
    // the pipeline falls back to the local heuristic scorer — no behaviour
    // change. Key via Docker secret `gemini_api_key` (preferred) or env.
    geminiKey: readSecret("gemini_api_key", { required: false }) || process.env.GEMINI_API_KEY || null,
    // Only an EXPLICIT override; otherwise the service auto-discovers a current
    // model (a stale default like gemini-2.0-flash is listed but dead → 404s).
    geminiModel: process.env.GEMINI_MODEL || null,
  },
};

export default config;
