import multer from "multer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";
import { httpError } from "./errorHandler.js";

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
