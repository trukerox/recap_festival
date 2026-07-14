// Scores each uploaded photo/clip on the dimensions the brief asks for
// (sharpness, lighting, faces/crowd, action level) and writes a single
// composite_score used for selection + ordering. See docs/ARCHITECTURE.md
// for the weighting rationale and the cloud-API upgrade path for higher
// quality crowd/emotion detection than the local Haar-cascade heuristic.
import { unlink } from "node:fs/promises";
import { analyzeImageQuality } from "./imageQuality.js";
import { analyzeVideoFrames } from "./videoQuality.js";
import { extractFrame } from "./frameExtract.js";
import { countFaces } from "./faceDetect.js";
import { upsertScore } from "../repositories/mediaScores.js";

const CLIP_WINDOW_SECONDS = 3;

// Brightness is scored by closeness to an ideal mid exposure (0.5), not by
// raw value — both under- and over-exposed frames should score low.
function brightnessScore(brightness) {
  return Math.max(0, 1 - Math.abs(brightness - 0.5) * 2);
}

function crowdScoreFrom(faceCount) {
  return Math.min(faceCount / 8, 1);
}

function shotTypeFrom(faceCount, avgFaceAreaRatio) {
  if (faceCount === 0) return null;
  if (faceCount >= 3 || avgFaceAreaRatio < 0.02) return "wide";
  return "close";
}

function compositeOf({ sharpness, brightness, contrast, crowdScore, motionScore, hasMotion }) {
  const weights = hasMotion
    ? { sharpness: 0.2, brightness: 0.15, contrast: 0.1, crowd: 0.25, motion: 0.3 }
    : { sharpness: 0.3, brightness: 0.2, contrast: 0.15, crowd: 0.35, motion: 0 };

  return (
    sharpness * weights.sharpness +
    brightnessScore(brightness) * weights.brightness +
    contrast * weights.contrast +
    crowdScore * weights.crowd +
    (motionScore ?? 0) * weights.motion
  );
}

// NB: per-image Gemini tagging was removed here — the Gemini DIRECTOR (one call
// over all footage, see queue/worker.js) now owns shot selection/ordering, so
// 28 per-image calls would just be wasted latency. This stays purely heuristic
// (fast, and the fallback when the director is off/unavailable).
async function analyzePhoto(mediaItem) {
  const [{ sharpness, brightness, contrast }, face] = await Promise.all([
    analyzeImageQuality(mediaItem.stored_path),
    countFaces(mediaItem.stored_path),
  ]);
  const crowdScore = crowdScoreFrom(face.faceCount);
  return {
    sharpness,
    brightness,
    contrast,
    faceCount: face.faceCount,
    crowdScore,
    motionScore: null,
    shotType: shotTypeFrom(face.faceCount, face.avgFaceAreaRatio),
    compositeScore: compositeOf({ sharpness, brightness, contrast, crowdScore, motionScore: 0, hasMotion: false }),
    trimStartSeconds: null,
    trimEndSeconds: null,
  };
}

async function analyzeVideo(mediaItem) {
  const stats = await analyzeVideoFrames(mediaItem.stored_path);
  const duration = Number(mediaItem.duration_seconds ?? 0);

  let framePath;
  let face = { faceCount: 0, avgFaceAreaRatio: 0 };
  try {
    framePath = await extractFrame(mediaItem.stored_path, stats.peakMotionTime || duration / 2);
    face = await countFaces(framePath);
  } finally {
    if (framePath) await unlink(framePath).catch(() => {});
  }

  const crowdScore = crowdScoreFrom(face.faceCount);
  const windowLen = Math.min(CLIP_WINDOW_SECONDS, duration || CLIP_WINDOW_SECONDS);
  const center = stats.peakMotionTime || duration / 2;
  const trimStart = Math.max(0, Math.min(center - windowLen / 2, Math.max(0, duration - windowLen)));

  return {
    sharpness: stats.sharpness,
    brightness: stats.brightness,
    contrast: stats.contrast,
    faceCount: face.faceCount,
    crowdScore,
    motionScore: stats.motionScore,
    shotType: shotTypeFrom(face.faceCount, face.avgFaceAreaRatio),
    compositeScore: compositeOf({ ...stats, crowdScore, hasMotion: true }),
    trimStartSeconds: trimStart,
    trimEndSeconds: trimStart + windowLen,
  };
}

export async function analyzeMediaItem(mediaItem) {
  const result = mediaItem.kind === "video" ? await analyzeVideo(mediaItem) : await analyzePhoto(mediaItem);
  return upsertScore(mediaItem.id, result);
}
