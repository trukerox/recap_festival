import { Router } from "express";
import { z } from "zod";
import { httpError } from "../middleware/errorHandler.js";
import { listActive, listAll, upsertTrack, setActive, updateFields } from "../repositories/musicTracks.js";
import { scrapePixabayTrack, downloadTrackFile, genreDefaultBpm } from "../services/musicImport.js";
import { detectBpm } from "../services/bpmDetect.js";

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
