// BPM detection, CPU-only, no external API.
//
// PRIMARY: aubio (a mature onset-based beat tracker) via scripts/bpm_aubio.py.
// Node decodes the track to a temp WAV with ffmpeg, then aubio analyses it.
// This is much more accurate on real music than the fallback below.
//
// FALLBACK (aubio missing/errored): the original hand-rolled estimator —
// ffmpeg low-passes the track to isolate bass/kick energy, decodes to raw
// mono PCM, and autocorrelates the energy envelope. Cruder; can lock onto a
// harmonic (report half/double the true tempo). Either way the result is
// always shown as editable, never as unquestionable fact.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";

const execFileAsync = promisify(execFile);
const AUBIO_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "bpm_aubio.py");

const SAMPLE_RATE = 11025; // plenty for beat-envelope analysis, keeps the buffer small
const ANALYZE_SECONDS = 30; // a representative middle chunk is enough; skip the intro
const SKIP_INTRO_SECONDS = 5;
const WINDOW_MS = 10;
const MIN_BPM = 60;
const MAX_BPM = 200;

// Fold a tempo into a musical 70-180 range to guard against octave errors
// (a detector reporting 200 or 60 gets folded toward the plausible tempo).
function foldTempo(bpm) {
  let b = bpm;
  while (b > 180) b /= 2;
  while (b < 70) b *= 2;
  return Math.round(b);
}

function decodeMonoPcm(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-ss", String(SKIP_INTRO_SECONDS),
      "-t", String(ANALYZE_SECONDS),
      "-i", filePath,
      "-af", "lowpass=f=150",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "f32le",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args);
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", () => {}); // ignore, we passed -v error
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code} decoding PCM for BPM analysis`));
      const buf = Buffer.concat(chunks);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
      resolve(new Float32Array(ab));
    });
  });
}

function energyEnvelope(samples, sampleRate, windowMs) {
  const windowSize = Math.round((sampleRate * windowMs) / 1000);
  const numWindows = Math.floor(samples.length / windowSize);
  const envelope = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const start = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    envelope[w] = Math.sqrt(sum / windowSize);
  }
  return envelope;
}

function autocorrelateBpm(envelope, windowMs, minBpm, maxBpm) {
  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  const centered = Float32Array.from(envelope, (v) => v - mean);

  const minLag = Math.max(1, Math.floor((60 / maxBpm) * 1000 / windowMs));
  const maxLag = Math.min(centered.length - 1, Math.ceil((60 / minBpm) * 1000 / windowMs));

  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < centered.length - lag; i++) sum += centered[i] * centered[i + lag];
    const score = sum / (centered.length - lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let zeroLagSum = 0;
  for (let i = 0; i < centered.length; i++) zeroLagSum += centered[i] * centered[i];
  const zeroLagNorm = zeroLagSum / centered.length;
  const confidence = zeroLagNorm > 0 ? Math.max(0, Math.min(1, bestScore / zeroLagNorm)) : 0;

  const periodMs = bestLag * windowMs;
  const bpm = Math.round(60000 / periodMs);
  return { bpm, confidence };
}

// Primary path: ffmpeg → temp WAV → aubio. Returns null (not throws) if aubio
// isn't available or produced nothing usable, so the caller falls back.
async function detectBpmAubio(filePath) {
  const wav = join(config.paths.tmpDir, `${randomUUID()}.wav`);
  try {
    await execFileAsync("ffmpeg", ["-v", "error", "-i", filePath, "-ac", "1", "-ar", "22050", wav], {
      timeout: 60_000,
    });
    const { stdout } = await execFileAsync("python3", [AUBIO_SCRIPT, wav], { timeout: 60_000 });
    const parsed = JSON.parse(stdout);
    if (parsed && parsed.bpm) {
      return { bpm: foldTempo(parsed.bpm), confidence: parsed.confidence ?? null, source: "aubio" };
    }
    return null;
  } catch {
    return null; // aubio/ffmpeg missing or failed — caller falls back
  } finally {
    await unlink(wav).catch(() => {});
  }
}

export async function detectBpm(filePath) {
  const viaAubio = await detectBpmAubio(filePath);
  if (viaAubio) return viaAubio;

  // Fallback: naive energy-envelope autocorrelation.
  const samples = await decodeMonoPcm(filePath);
  if (samples.length < SAMPLE_RATE) {
    // Track shorter than the intro-skip + analysis window — bail out cleanly.
    return { bpm: null, confidence: 0 };
  }
  const envelope = energyEnvelope(samples, SAMPLE_RATE, WINDOW_MS);
  const result = autocorrelateBpm(envelope, WINDOW_MS, MIN_BPM, MAX_BPM);
  return { bpm: foldTempo(result.bpm), confidence: result.confidence, source: "autocorrelation" };
}

// Rough genre-typical tempo, NOT a measurement — used only as the fallback
// when detectBpm() can't produce a value (e.g. a track too short to analyse).
// Always presented as editable, never as fact.
const GENRE_DEFAULT_BPM = { edm: 128, electronic: 124, festival: 126, pop: 110, cinematic: 90 };
export function genreDefaultBpm(genre) {
  return GENRE_DEFAULT_BPM[genre] ?? 126;
}
