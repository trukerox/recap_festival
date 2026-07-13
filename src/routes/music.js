import { Router } from "express";
import { z } from "zod";
import { httpError } from "../middleware/errorHandler.js";
import { listActive, listAll, upsertTrack, setActive } from "../repositories/musicTracks.js";
import { scrapePixabayTrack, downloadTrackFile, genreDefaultBpm } from "../services/musicImport.js";

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
// lets the frontend show an editable confirm form (genre/bpm can't be
// scraped from anywhere and always need a human to confirm them).
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
  bpm: z.number().int().min(40).max(240),
});

// Step 2: re-scrapes server-side (never trusts client-supplied title/duration/
// download URL), downloads the mp3 into music/, and upserts the DB row.
musicRouter.post("/import", async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const meta = await scrapePixabayTrack(body.url);
    const { filePath } = await downloadTrackFile(meta.contentUrl, meta.title);
    const track = await upsertTrack({
      title: meta.title,
      artist: meta.artist,
      genre: body.genre,
      bpm: body.bpm,
      durationSeconds: meta.durationSeconds,
      filePath,
      license: meta.license,
      sourceUrl: meta.sourceUrl,
    });
    res.status(201).json(track);
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

export default musicRouter;
