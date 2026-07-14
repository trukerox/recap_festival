// Extracts evenly-spaced keyframes from a rendered video and tiles them into a
// single contact-sheet JPG. Used by the Videos tab so a render can be reviewed
// at a glance (and screenshotted) without playing the video.
import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";

function probeDuration(path) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(path, (err, data) => {
      resolve(err ? null : data?.format?.duration ? Number(data.format.duration) : null);
    });
  });
}

const COLS = 3;
const ROWS = 4; // 12 frames — enough to see every clip in a short recap

export async function makeContactSheet(videoPath) {
  const duration = (await probeDuration(videoPath)) || 16;
  const n = COLS * ROWS;
  // Spread ~n samples across the whole clip.
  const fps = Math.max(0.05, n / (duration + 0.1));
  const out = join(config.paths.tmpDir, `${randomUUID()}.jpg`);

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-an",
      "-i", videoPath,
      // scale -2 keeps dimensions even (odd sizes make the JPEG encoder fail);
      // explicit tile layout= is the robust form.
      "-vf", `fps=${fps.toFixed(4)},scale=300:-2,tile=layout=${COLS}x${ROWS}:padding=6:color=black`,
      "-frames:v", "1",
      out,
    ];
    let stderr = "";
    const proc = spawn("ffmpeg", args);
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg contact sheet failed (${code}): ${stderr.slice(-600)}`)),
    );
  });

  return out;
}
