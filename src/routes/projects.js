import { Router } from "express";
import { z } from "zod";
import { relative } from "node:path";
import config from "../config/index.js";
import { httpError } from "../middleware/errorHandler.js";
import { mediaUpload, kindForMime } from "../middleware/upload.js";
import { createProject, getProject, setWatermark } from "../repositories/projects.js";
import { insertMediaItem, listByProject, countByProject } from "../repositories/mediaItems.js";
import { createJob } from "../repositories/renderJobs.js";
import { pickForStyle } from "../repositories/musicTracks.js";
import { probeMedia } from "../services/mediaProbe.js";
import { sha256File } from "../utils/checksum.js";
import { pickRandomStyle } from "../services/styles.js";

export const projectsRouter = Router();

const createProjectSchema = z.object({
  eventName: z.string().min(1).max(255),
  location: z.string().max(255).optional(),
  eventDate: z.string().date().optional(), // "YYYY-MM-DD"
  musicStyle: z.enum(["electronic", "edm", "festival", "pop", "cinematic", "auto"]).optional(),
  ctaText: z.string().max(255).optional(),
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    const body = createProjectSchema.parse(req.body);
    const project = await createProject(body);
    res.status(201).json(project);
  } catch (err) {
    next(err.issues ? httpError(400, err.issues.map((i) => i.message).join("; ")) : err);
  }
});

projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) throw httpError(404, "Project not found");
    const media = await listByProject(req.params.id);
    res.json({ ...project, media });
  } catch (err) {
    next(err);
  }
});

// Accepts up to MAX_UPLOAD_FILES photos/clips under "media", plus one optional
// logo/watermark image under "watermark".
projectsRouter.post(
  "/:id/media",
  mediaUpload.fields([
    { name: "media", maxCount: config.upload.maxFiles },
    { name: "watermark", maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const project = await getProject(req.params.id);
      if (!project) throw httpError(404, "Project not found");

      const mediaFiles = req.files?.media ?? [];
      const watermarkFile = req.files?.watermark?.[0];

      if (watermarkFile) {
        if (!watermarkFile.mimetype.startsWith("image/")) {
          throw httpError(400, "Watermark must be an image");
        }
        await setWatermark(project.id, watermarkFile.path);
      }

      const existingCount = await countByProject(project.id);
      if (existingCount + mediaFiles.length > config.upload.maxFiles) {
        throw httpError(400, `Project already has ${existingCount} files — limit is ${config.upload.maxFiles}`);
      }

      const saved = [];
      for (const file of mediaFiles) {
        const kind = kindForMime(file.mimetype);
        const [checksum, meta] = await Promise.all([
          sha256File(file.path),
          probeMedia(file.path, kind),
        ]);
        const item = await insertMediaItem({
          projectId: project.id,
          kind,
          originalFilename: file.originalname,
          storedPath: relative(process.cwd(), file.path),
          mimeType: file.mimetype,
          fileSizeBytes: file.size,
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.durationSeconds,
          checksumSha256: checksum,
        });
        saved.push(item);
      }

      res.status(201).json({ saved });
    } catch (err) {
      next(err);
    }
  },
);

const renderSchema = z.object({
  musicTrackId: z.number().int().positive().optional(),
});

projectsRouter.post("/:id/render", async (req, res, next) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) throw httpError(404, "Project not found");

    const mediaCount = await countByProject(project.id);
    if (mediaCount < 3) {
      throw httpError(400, "Need at least 3 photos/clips to generate a recap");
    }

    const body = renderSchema.parse(req.body ?? {});

    // Auto-pick a random edit style so each render looks different. When the
    // project's music style is "auto", let the chosen style set the music vibe;
    // otherwise honour the user's explicit music choice.
    const style = pickRandomStyle();
    const musicGenre = project.music_style && project.music_style !== "auto" ? project.music_style : style.musicGenre;
    const musicTrackId =
      body.musicTrackId ?? (await pickForStyle(musicGenre))?.id ?? (await pickForStyle("auto"))?.id ?? null;
    if (!musicTrackId) throw httpError(503, "No music tracks available — add tracks to the library first");

    const job = await createJob({ projectId: project.id, musicTrackId, style: style.name });
    res.status(202).json(job);
  } catch (err) {
    next(err.issues ? httpError(400, err.issues.map((i) => i.message).join("; ")) : err);
  }
});

export default projectsRouter;
