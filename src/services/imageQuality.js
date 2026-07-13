// Sharpness/brightness/contrast metrics computed with `sharp` only — no
// native OpenCV needed for these, so they're cheap enough to run on every
// candidate frame even on Pi CPU.
import sharp from "sharp";

const ANALYSIS_MAX_DIM = 640; // downscale before analysis; result is a proxy score, not exact
const LAPLACIAN_KERNEL = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };

// Variance of the Laplacian is the standard cheap blur-detection metric:
// higher variance = more high-frequency edge content = sharper image.
export async function computeSharpness(path) {
  const { data, info } = await sharp(path)
    .resize({ width: ANALYSIS_MAX_DIM, height: ANALYSIS_MAX_DIM, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (data[i] - mean) ** 2;
  variance /= n;

  // Empirically, variance above ~1000 on a downscaled 640px frame reads as
  // "sharp"; clamp+normalise to 0..1 rather than exposing the raw variance.
  return Math.min(variance / 1000, 1);
}

export async function computeBrightnessContrast(path) {
  const stats = await sharp(path).greyscale().stats();
  const channel = stats.channels[0];
  const brightness = channel.mean / 255; // 0..1, 0.5 ~ well-exposed
  const contrast = Math.min(channel.stdev / 80, 1); // 0..1, higher = more contrast
  return { brightness, contrast };
}

export async function analyzeImageQuality(path) {
  const [sharpness, { brightness, contrast }] = await Promise.all([
    computeSharpness(path),
    computeBrightnessContrast(path),
  ]);
  return { sharpness, brightness, contrast };
}
