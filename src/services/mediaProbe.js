// Extracts the metadata we store per media_item at upload time (not scoring —
// see services/mediaAnalysis.js for the quality/selection scoring pass).
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

export async function probeImage(path) {
  const meta = await sharp(path).metadata();
  return { width: meta.width ?? null, height: meta.height ?? null, durationSeconds: null };
}

export function probeVideo(path) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find((s) => s.codec_type === "video");
      resolve({
        width: stream?.width ?? null,
        height: stream?.height ?? null,
        durationSeconds: data.format?.duration ? Number(data.format.duration) : null,
      });
    });
  });
}

export async function probeMedia(path, kind) {
  return kind === "video" ? probeVideo(path) : probeImage(path);
}
