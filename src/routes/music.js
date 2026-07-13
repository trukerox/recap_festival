import { Router } from "express";
import { z } from "zod";
import { basename } from "node:path";
import { httpError } from "../middleware/errorHandler.js";
import { musicUpload } from "../middleware/upload.js";
import { listActive, listAll, upsertTrack, setActive, updateFields } from "../repositories/musicTracks.js";
import { detectBpm, genreDefaultBpm } from "../services/bpmDetect.js";
import { probeAudioDuration } from "../services/mediaProbe.js";

export const musicRouter = Router();

musicRouter.get("/", async (req, res, next) => {
  try {
    res.json(await listActive(req.query.genre));
  } catch (err) {
    next(err);
  }
});

musicRouter.get("/all", async (_req, res, next) => {
  try {
    res.json(await listAll());
  } catch (err) {
    next(err);
  }
});

const uploadSchema = z.object({
  title: z.string().min(1).max(255),
  artist: z.string().max(255).optional(),
  genre: z.enum(["electronic", "edm", "festival", "pop", "cinematic"]),
  license: z.string().max(64).optional(),
  sourceUrl: z.string().url().max(512).optional(),
  bpm: z.coerce.number().int().min(40).max(240).optional(),
});

// The single server-side "add a track" path. The audio bytes always arrive
// from a browser (either the Music-tab upload form or the extension, which
// downloads the mp3 in your logged-in browser) — the server never fetches the
// source site itself, because Pixabay 403s server-side requests. BPM is
// auto-detected from the uploaded audio unless a value is supplied. Multipart:
// file field "audio" plus text fields title/genre/artist?/license?/sourceUrl?/bpm?.
musicRouter.post("/upload", musicUpload.single("audio"), async (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, "No audio file uploaded (form field 'audio')");
    // Multipart text fields arrive as strings; drop empty ones so optional
    // validators (e.g. sourceUrl .url()) don't choke on "".
    const clean = Object.fromEntries(
      Object.entries(req.body).filter(([, v]) => v !== undefined && v !== ""),
    );
    const body = uploadSchema.parse(clean);
    const filePath = `music/${basename(req.file.path)}`;

    const [duration, detected] = await Promise.all([
      probeAudioDuration(req.file.path).catch(() => null),
      body.bpm == null ? detectBpm(req.file.path).catch(() => ({ bpm: null, confidence: 0 })) : null,
    ]);

    let bpm = body.bpm;
    let bpmSource = "manual";
    let bpmConfidence = null;
    if (bpm == null) {
      bpm = detected.bpm ?? genreDefaultBpm(body.genre);
      bpmSource = detected.bpm != null ? "detected" : "genre-default";
      bpmConfidence = detected.confidence;
    }

    const track = await upsertTrack({
      title: body.title,
      artist: body.artist ?? null,
      genre: body.genre,
      bpm,
      durationSeconds: duration,
      filePath,
      license: body.license ?? "user-provided",
      sourceUrl: body.sourceUrl ?? null,
    });
    res.status(201).json({ ...track, bpmSource, bpmConfidence });
  } catch (err) {
    if (err.issues) return next(httpError(400, err.issues.map((i) => i.message).join("; ")));
    next(err);
  }
});

musicRouter.patch("/:id/active", async (req, res, next) => {
  try {
    const active = Boolean(req.body?.active);
    res.json(await setActive(req.params.id, active));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  bpm: z.number().int().min(40).max(240).optional(),
  genre: z.enum(["electronic", "edm", "festival", "pop", "cinematic"]).optional(),
});

// Corrects an auto-detected BPM or a misjudged genre after the fact.
musicRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    res.json(await updateFields(req.params.id, body));
  } catch (err) {
    next(err.issues ? httpError(400, err.issues.map((i) => i.message).join("; ")) : err);
  }
});

export default musicRouter;
