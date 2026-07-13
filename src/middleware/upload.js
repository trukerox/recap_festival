import multer from "multer";
import { mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import { httpError } from "./errorHandler.js";
import { slugify } from "../utils/slugify.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime", // .mov
]);

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

function projectUploadDir(projectId) {
  const dir = join(config.paths.uploadDir, String(projectId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, projectUploadDir(req.params.id));
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    cb(null, `${randomUUID()}${EXT_BY_MIME[file.mimetype] || ""}`);
  },
});

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(httpError(415, `Unsupported file type: ${file.mimetype}`));
  }
  cb(null, true);
}

export const mediaUpload = multer({
  storage,
  fileFilter,
  limits: {
    files: config.upload.maxFiles,
    fileSize: config.upload.maxFileMb * 1024 * 1024,
  },
});

export function kindForMime(mimeType) {
  return mimeType.startsWith("video/") ? "video" : "photo";
}

// ── Music upload ─────────────────────────────────────────────────────────────
// Separate from mediaUpload: audio files go straight into the music library
// dir (bind-mounted /mnt/storage/festival_recap/music), not a per-project
// upload folder. Used by the "upload a track you downloaded" path, which is
// the reliable alternative to URL import (Pixabay blocks server-side fetches).
const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
]);

const musicStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      mkdirSync(config.paths.musicDir, { recursive: true });
      cb(null, config.paths.musicDir);
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    const base = slugify(file.originalname.replace(/\.[^.]+$/, "")) || randomUUID();
    const ext = extname(file.originalname).toLowerCase() || ".mp3";
    cb(null, `${base}${ext}`);
  },
});

function audioFilter(_req, file, cb) {
  const ok = ALLOWED_AUDIO_MIME.has(file.mimetype) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.originalname);
  if (!ok) return cb(httpError(415, `Unsupported audio type: ${file.mimetype}`));
  cb(null, true);
}

export const musicUpload = multer({
  storage: musicStorage,
  fileFilter: audioFilter,
  limits: { files: 1, fileSize: 30 * 1024 * 1024 }, // 30MB is plenty for a short track
});
