import ffmpeg from "fluent-ffmpeg";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";

// Grabs a single representative frame as a JPEG for face/crowd detection.
export function extractFrame(videoPath, timestampSeconds) {
  const outPath = join(config.paths.tmpDir, `${randomUUID()}.jpg`);
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(Math.max(0, timestampSeconds))
      .frames(1)
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}
