// Estimates BPM directly from the downloaded audio file — no external API,
// no heavy ML dependency (fits the same CPU-only philosophy as the rest of
// the scoring pipeline). Approach: ffmpeg low-passes the track to isolate
// bass/kick energy (the clearest beat signal in EDM/festival/dubstep — the
// genres this tool cares about most), decodes to raw mono PCM, computes a
// short-time energy envelope, then autocorrelates that envelope over the
// 60-200 BPM lag range and picks the strongest periodicity.
//
// Known limitation: naive autocorrelation on a real track can lock onto a
// harmonic of the true tempo (reporting half or double, e.g. 70 vs 140).
// This is a real, unavoidable limitation of the technique, not a bug — the
// result is always shown as editable, never as unquestionable fact.
import { spawn } from "node:child_process";

const SAMPLE_RATE = 11025; // plenty for beat-envelope analysis, keeps the buffer small
const ANALYZE_SECONDS = 30; // a representative middle chunk is enough; skip the intro
const SKIP_INTRO_SECONDS = 5;
const WINDOW_MS = 10;
const MIN_BPM = 60;
const MAX_BPM = 200;

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

export async function detectBpm(filePath) {
  const samples = await decodeMonoPcm(filePath);
  if (samples.length < SAMPLE_RATE) {
    // Track shorter than the intro-skip + analysis window — bail out cleanly.
    return { bpm: null, confidence: 0 };
  }
  const envelope = energyEnvelope(samples, SAMPLE_RATE, WINDOW_MS);
  return autocorrelateBpm(envelope, WINDOW_MS, MIN_BPM, MAX_BPM);
}
