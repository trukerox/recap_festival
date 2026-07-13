import { Router } from "express";
import { z } from "zod";
import { basename } from "node:path";
import { httpError } from "../middleware/errorHandler.js";
import { musicUpload } from "../middleware/upload.js";
import { listActive, listAll, upsertTrack, setActive, updateFields } from "../repositories/musicTracks.js";
import { scrapePixabayTrack, downloadTrackFile, genreDefaultBpm } from "../services/musicImport.js";
import { detectBpm } from "../services/bpmDetect.js";
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

// Step 1 of "add by URL": scrape metadata only, no download/DB write yet —
// lets the frontend show an editable confirm form. Genre can't be scraped
// reliably and BPM can't be scraped at all (Pixabay doesn't publish it) —
// real BPM detection only happens in /import, after the file is downloaded
// (see services/bpmDetect.js).
musicRouter.get("/preview", async (req, res, next) => {
  try {
    const url = req.query.url;
    if (!url) throw httpError(400, "Missing ?url=");
    const meta = await scrapePixabayTrack(String(url));
    res.json({
      title: meta.title,
      artist: meta.artist,
      durationSeconds: meta.durationSeconds,
      license: meta.license,
      sourceUrl: meta.sourceUrl,
      suggestedGenre: meta.suggestedGenre,
      suggestedBpm: genreDefaultBpm(meta.suggestedGenre),
    });
  } catch (err) {
    next(err.message ? httpError(422, err.message) : err);
  }
});

const importSchema = z.object({
  url: z.string().url(),
  genre: z.enum(["electronic", "edm", "festival", "pop", "cinematic"]),
  // Omit bpm to auto-detect from the downloaded audio instead of trusting a
  // pre-download genre-typical guess. Still overridable if you already know
  // the real tempo.
  bpm: z.number().int().min(40).max(240).optional(),
});

// Step 2: re-scrapes server-side (never trusts client-supplied title/duration/
// download URL), downloads the mp3 into music/, auto-detects BPM from the
// actual audio unless the caller supplied one, and upserts the DB row.
musicRouter.post("/import", async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const meta = await scrapePixabayTrack(body.url);
    const { absPath, filePath } = await downloadTrackFile(meta.contentUrl, meta.title);

    let bpm = body.bpm;
    let bpmSource = "manual";
    let bpmConfidence = null;
    if (bpm == null) {
      const detected = await detectBpm(absPath).catch(() => ({ bpm: null, confidence: 0 }));
      bpm = detected.bpm ?? genreDefaultBpm(body.genre);
      bpmSource = detected.bpm != null ? "detected" : "genre-default";
      bpmConfidence = detected.confidence;
    }

    const track = await upsertTrack({
      title: meta.title,
      artist: meta.artist,
      genre: body.genre,
      bpm,
      durationSeconds: meta.durationSeconds,
      filePath,
      license: meta.license,
      sourceUrl: meta.sourceUrl,
    });
    // bpmSource/bpmConfidence are NOT persisted (no schema column for them) —
    // returned once so the UI can say "auto-detected, confidence 62% — edit
    // if it sounds wrong" right after import, via PATCH /:id below.
    res.status(201).json({ ...track, bpmSource, bpmConfidence });
  } catch (err) {
    if (err.issues) return next(httpError(400, err.issues.map((i) => i.message).join("; ")));
    next(err.message ? httpError(422, err.message) : err);
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

// The reliable "add a track" path: you download the mp3 in your browser (which
// passes the source site's bot check that a server-side fetch can't — see
// services/musicImport.js) and upload the file here. BPM is auto-detected from
// the uploaded audio unless you supplied one. Multipart: file field "audio"
// plus text fields title/genre/artist?/license?/sourceUrl?/bpm?.
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
