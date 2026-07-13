// Generates the professional branded end card (last ~3s of the recap) as a
// 1080x1920 PNG: dark festival-night background, Evestival logo, an
// evestival.com call-to-action button in the brand orange, and a tagline.
//
// Rendered from an SVG via rsvg-convert (librsvg2-bin) — SVG gives real design
// control (gradients, a rounded button, precise layout) that ffmpeg drawtext
// can't. The composer uses the PNG as the final timeline segment.
import { writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import config from "../config/index.js";

const execFileAsync = promisify(execFile);

// Evestival brand palette (sampled from the site).
const ORANGE = "#E07A1E";
const ORANGE_LIGHT = "#F4A24C";

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function endCardSvg({ eventName, ctaUrl, width, height }) {
  const cx = width / 2;
  const ev = eventName ? escapeXml(eventName.toUpperCase()) : "";
  const url = escapeXml(ctaUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1530"/>
      <stop offset="0.55" stop-color="#120f1e"/>
      <stop offset="1" stop-color="#0b0912"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.66" r="0.55">
      <stop offset="0" stop-color="${ORANGE}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${ORANGE}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>

  <!-- logo: diamond + wordmark -->
  <g transform="translate(${cx}, 320)">
    <rect x="-26" y="-26" width="52" height="52" rx="9" transform="rotate(45)" fill="${ORANGE}"/>
    <text x="0" y="118" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="54" letter-spacing="16" fill="#ffffff">EVESTIVAL</text>
  </g>

  ${ev ? `<text x="${cx}" y="600" text-anchor="middle" font-family="DejaVu Sans" font-size="30" letter-spacing="7" fill="#b7add0">${ev}</text>` : ""}

  <!-- headline -->
  <text x="${cx}" y="930" text-anchor="middle" font-family="DejaVu Serif" font-weight="bold" font-size="120" fill="#ffffff">Want more</text>
  <text x="${cx}" y="1065" text-anchor="middle" font-family="DejaVu Serif" font-weight="bold" font-style="italic" font-size="120" fill="${ORANGE_LIGHT}">festivals?</text>

  <!-- call-to-action button -->
  <g transform="translate(${cx}, 1290)">
    <rect x="-350" y="-72" width="700" height="144" rx="72" fill="${ORANGE}"/>
    <text x="0" y="20" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="54" letter-spacing="2" fill="#160d02">${url}  &#8594;</text>
  </g>

  <!-- tagline -->
  <text x="${cx}" y="1620" text-anchor="middle" font-family="DejaVu Serif" font-style="italic" font-size="42" fill="#9a90b8">Find the moments that move you.</text>
</svg>`;
}

// Returns the path to a generated PNG. Caller is responsible for unlinking it
// after the render.
export async function generateEndCard({ eventName, width, height, ctaUrl = "evestival.com" }) {
  const svg = endCardSvg({ eventName, ctaUrl, width, height });
  const svgPath = join(config.paths.tmpDir, `${randomUUID()}.svg`);
  const pngPath = join(config.paths.tmpDir, `${randomUUID()}.png`);
  await writeFile(svgPath, svg, "utf8");
  try {
    await execFileAsync(
      "rsvg-convert",
      ["-w", String(width), "-h", String(height), "-o", pngPath, svgPath],
      { timeout: 30_000 },
    );
  } finally {
    await unlink(svgPath).catch(() => {});
  }
  return pngPath;
}
