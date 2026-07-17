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

// Detects the ACTUAL beat timestamps (seconds) in a track via aubio — the
// caller cuts ON these so the edit lands on the real kicks, not a fixed grid
// from t=0 (which ignores the song's intro and any drift). Also returns the
// per-beat loudness ("energies", 0..1, same length as beats) and the DROP —
// the beat where sustained energy jumps the most — so the edit can put its
// strongest shot on the musical payoff and keep the flashy transitions to the
// high-energy stretches. Returns { beats: [], energies: [], drop: null } if
// aubio is unavailable/failed. Analyses the whole track (unlike detectBpm's
// 30s window) so beats cover the full render length.
export async function detectBeats(filePath) {
  const wav = join(config.paths.tmpDir, `${randomUUID()}.wav`);
  try {
    await execFileAsync("ffmpeg", ["-v", "error", "-i", filePath, "-ac", "1", "-ar", "22050", wav], {
      timeout: 90_000,
    });
    const { stdout } = await execFileAsync("python3", [AUBIO_SCRIPT, wav], {
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const beats = Array.isArray(parsed?.beats) ? parsed.beats.filter((b) => Number.isFinite(b)) : [];
    const energies =
      Array.isArray(parsed?.energies) && parsed.energies.length === beats.length
        ? parsed.energies.map((e) => (Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : 0))
        : [];
    return {
      beats,
      energies,
      drop: Number.isFinite(parsed?.drop) ? parsed.drop : null,
      bpm: parsed?.bpm ? foldTempo(parsed.bpm) : null,
    };
  } catch {
    return { beats: [], energies: [], drop: null, bpm: null };
  } finally {
    await unlink(wav).catch(() => {});
  }
}

// Tempo implied by the MEASURED beat gaps. Deliberately mirrors selection.js's
// medianGap — the value its beatsFor() divides by — so a style judged against
// this number is judged against exactly what the cutter will really do.
//
// Prefer this over a track's stored bpm at render time: the stored value is a
// detection guess that can be hand-corrected in the Music tab (possibly after a
// job was queued), while the beats are measured from the audio each render.
// Needs a few beats before a median means anything.
export function bpmFromBeats(beats) {
  if (!Array.isArray(beats) || beats.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0 ? 60 / median : null;
}

// Play the 30 seconds of the track that CONTAIN the drop, instead of the first 30.
//
// The drop is the song's payoff, and a lot hangs off it: the impact SFX, the riser
// building into it, the strongest shot reserved for it, the cuts accelerating in,
// and the hold afterwards. All of it worked and almost none of it ever ran —
// observed firing on 1 render in 4. Real tracks drop at 45s-2min; a 30s reel played
// the track from t=0, so `drop` fell outside the usable window and every one of
// those features silently no-opped.
//
// This changes WHICH 30 seconds are used, not how much: same song, same length,
// same volume — the chorus instead of the intro.
//
// beats/energies/drop are all measured from the track's t=0 and every cut is placed
// ON a beat, so they must ALL rebase together with the trim. Rebasing the audio
// without the beats would put every cut off the music — worse than the bug.
export function alignMusicToDrop({
  beats = [],
  energies = [],
  drop,
  trackDuration,
  renderDuration,
  dropAtFraction = 0.65, // ~19.5s into a 30s reel: room to build, then breathe before the end card
}) {
  const unchanged = { musicStart: 0, beats, energies, drop };
  if (!Number.isFinite(drop) || !Number.isFinite(renderDuration)) return unchanged;

  let musicStart = drop - renderDuration * dropAtFraction;
  if (musicStart <= 0) return unchanged; // already drops early enough — leave it alone

  // Never trim so late that the reel runs off the end of the track into silence.
  // Clamping can leave the drop later than we wanted, which is fine — late but
  // present beats absent.
  if (Number.isFinite(trackDuration) && trackDuration > renderDuration) {
    musicStart = Math.min(musicStart, trackDuration - renderDuration);
  }
  if (musicStart <= 0) return unchanged;

  const haveEnergies = energies.length === beats.length;
  const rebasedBeats = [];
  const rebasedEnergies = [];
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i] - musicStart;
    if (t < 0) continue; // beat is before the new start — it no longer exists in this reel
    rebasedBeats.push(t);
    if (haveEnergies) rebasedEnergies.push(energies[i]);
  }
  // Too few beats left to cut against (a drop very near the track's end). Better the
  // old behaviour than a reel with nothing to land on.
  if (rebasedBeats.length < 8) return unchanged;

  return { musicStart, beats: rebasedBeats, energies: rebasedEnergies, drop: drop - musicStart };
}

// Rough genre-typical tempo, NOT a measurement — used only as the fallback
// when detectBpm() can't produce a value (e.g. a track too short to analyse).
// Always presented as editable, never as fact.
const GENRE_DEFAULT_BPM = { edm: 128, electronic: 124, festival: 126, pop: 110, cinematic: 90 };
export function genreDefaultBpm(genre) {
  return GENRE_DEFAULT_BPM[genre] ?? 126;
}
