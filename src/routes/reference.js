// Reference-clip library: upload standalone example videos (e.g. Canva
// exports) and play them back in the Videos tab. Filesystem-backed (no DB) —
// the reference dir is the source of truth.
import { Router } from "express";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import config from "../config/index.js";
import { httpError } from "../middleware/errorHandler.js";
import { referenceUpload } from "../middleware/upload.js";
import { makeContactSheet } from "../services/contactSheet.js";

export const referenceRouter = Router();

const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;

// basename() strips any path components, so a client can't traverse out of the
// reference dir via the :name param.
function safeRefPath(name) {
  return join(config.paths.referenceDir, basename(name));
}

referenceRouter.get("/", async (_req, res, next) => {
  try {
    let files = [];
    try {
      files = await readdir(config.paths.referenceDir);
    } catch {
      files = []; // dir not created yet
    }
    const clips = [];
    for (const name of files.filter((f) => VIDEO_RE.test(f))) {
      const s = await stat(join(config.paths.referenceDir, name)).catch(() => null);
      if (s) clips.push({ name, sizeBytes: s.size, uploadedAt: s.mtime });
    }
    clips.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json(clips);
  } catch (err) {
    next(err);
  }
});

referenceRouter.post("/", referenceUpload.single("video"), (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, "No video uploaded (form field 'video')");
    res.status(201).json({ name: basename(req.file.path) });
  } catch (err) {
    next(err);
  }
});

// Keyframe contact sheet for a reference clip (same as renders).
referenceRouter.get("/:name/frames", async (req, res, next) => {
  try {
    const sheet = await makeContactSheet(resolve(safeRefPath(req.params.name)));
    res.sendFile(sheet, (err) => {
      unlink(sheet).catch(() => {});
      if (err && !res.headersSent) next(httpError(404, "Clip not found"));
    });
  } catch (err) {
    next(err);
  }
});

referenceRouter.get("/:name/video", async (req, res, next) => {
  try {
    const abs = resolve(safeRefPath(req.params.name));
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) next(httpError(404, "Clip not found"));
    });
  } catch (err) {
    next(err);
  }
});

referenceRouter.delete("/:name", async (req, res, next) => {
  try {
    await unlink(safeRefPath(req.params.name)).catch(() => {});
    res.json({ ok: true, deleted: basename(req.params.name) });
  } catch (err) {
    next(err);
  }
});

export default referenceRouter;
