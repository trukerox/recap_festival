// Per-frame quality/motion stats for a video clip using ffprobe's `lavfi`
// virtual input to run the `blurdetect` + `signalstats` filters and read
// their per-frame metadata — all CPU-only, no GPU, works fine on a Pi.
//
// Assumes a Linux container path (no drive letters/colons in the path),
// which is the only environment this service is designed to run in.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Sample every 15th decoded frame (~0.5s at 30fps) — enough resolution for a
// clip a few seconds long without decoding/analysing every single frame.
const FRAME_STRIDE = 15;

export async function analyzeVideoFrames(path) {
  const filterChain = `movie=${path},select='not(mod(n\\,${FRAME_STRIDE}))',blurdetect,signalstats`;
  const args = [
    "-v", "quiet",
    "-print_format", "json",
    "-f", "lavfi",
    "-i", filterChain,
    "-show_entries", "frame=best_effort_timestamp_time:frame_tags=lavfi.blur,lavfi.signalstats.YDIF,lavfi.signalstats.YAVG",
  ];

  const { stdout } = await execFileAsync("ffprobe", args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const frames = (parsed.frames ?? []).map((f) => ({
    t: Number(f.best_effort_timestamp_time ?? 0),
    blur: Number(f.tags?.["lavfi.blur"] ?? 0),
    motion: Number(f.tags?.["lavfi.signalstats.YDIF"] ?? 0),
    brightness: Number(f.tags?.["lavfi.signalstats.YAVG"] ?? 0),
  }));

  if (frames.length === 0) {
    return { sharpness: 0.5, brightness: 0.5, contrast: 0.5, motionScore: 0, peakMotionTime: 0 };
  }

  const avg = (key) => frames.reduce((s, f) => s + f[key], 0) / frames.length;
  const avgBlur = avg("blur"); // ffmpeg's blurdetect: ~0 sharp, ~1 very blurry
  const avgMotion = avg("motion"); // mean luma diff between consecutive sampled frames
  const avgBrightness = avg("brightness") / 255;

  const peak = frames.reduce((best, f) => (f.motion > best.motion ? f : best), frames[0]);

  return {
    sharpness: Math.max(0, Math.min(1 - avgBlur, 1)),
    brightness: avgBrightness,
    contrast: 0.5, // signalstats doesn't give a direct contrast figure per-frame; left neutral
    motionScore: Math.min(avgMotion / 20, 1), // empirical normalisation, tune against real footage
    peakMotionTime: peak.t,
  };
}
