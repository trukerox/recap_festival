// "Paste a link, get a track" — scrapes the metadata Pixabay embeds as a
// schema.org AudioObject JSON-LD block (title, artist, duration, and a
// direct CDN mp3 URL) and downloads the file straight into music/. Only
// Pixabay track pages are understood; anything else throws a clear error so
// the caller can fall back to manual entry (see docs/ARCHITECTURE.md).
//
// BPM is never published on the page (no source scrapes real BPM) — callers
// must always supply it, with genreDefaultBpm() only ever used as an
// editable starting guess, never presented as a measured fact.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import config from "../config/index.js";
import { slugify } from "../utils/slugify.js";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  const [, h, min, s] = m;
  return (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
}

const GENRE_KEYWORDS = [
  ["edm", ["edm", "dubstep", "drum and bass", "drum & bass", " dnb", "bass drop"]],
  ["electronic", ["electronic", "synth", "techno"]],
  ["cinematic", ["cinematic", "trailer", "epic", "orchestral"]],
  ["pop", ["pop"]],
  ["festival", ["festival"]],
];

// Best-effort guess only — always shown to the user as editable, never saved
// without confirmation. Falls back to "festival" since that's this tool's
// primary use case.
export function guessGenre(title) {
  const lower = title.toLowerCase();
  for (const [genre, keywords] of GENRE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return genre;
  }
  return "festival";
}

// Rough genre-typical tempo, NOT a measurement of the specific track. Always
// present this as an editable starting point in the UI, never as fact.
const GENRE_DEFAULT_BPM = { edm: 128, electronic: 124, festival: 126, pop: 110, cinematic: 90 };
export function genreDefaultBpm(genre) {
  return GENRE_DEFAULT_BPM[genre] ?? 126;
}

function isPixabayTrackUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)pixabay\.com$/.test(u.hostname) && u.pathname.includes("/music/");
  } catch {
    return false;
  }
}

export async function scrapePixabayTrack(url) {
  if (!isPixabayTrackUrl(url)) {
    throw new Error("Only pixabay.com/music/... track links are supported for auto-import right now");
  }

  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    throw new Error(`Pixabay returned HTTP ${res.status} — it may be blocking this server's requests`);
  }
  const html = await res.text();

  // Pixabay embeds a schema.org AudioObject <script type="application/ld+json">
  // block per track page — pull the one with @type AudioObject specifically,
  // since the page also has an unrelated WebSite JSON-LD block.
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  let audio = null;
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed["@type"] === "AudioObject") {
        audio = parsed;
        break;
      }
    } catch {
      // ignore unparseable blocks
    }
  }
  if (!audio) throw new Error("Could not find track metadata on the page — Pixabay may have changed its layout");

  const title = audio.name?.replace(/\s*\|\s*Royalty-free Music\s*$/i, "").trim() ?? "Untitled";
  const artist = audio.creator?.name ?? null;
  const durationSeconds = parseIsoDuration(audio.duration);
  const contentUrl = audio.contentUrl;
  if (!contentUrl) throw new Error("No downloadable audio URL found in the track's metadata");

  return {
    title,
    artist,
    durationSeconds,
    contentUrl,
    license: "Pixabay Content License",
    sourceUrl: url,
    suggestedGenre: guessGenre(title),
  };
}

export async function downloadTrackFile(contentUrl, title) {
  await mkdir(config.paths.musicDir, { recursive: true });

  let baseName;
  try {
    baseName = new URL(contentUrl).searchParams.get("filename")?.replace(/\.mp3$/i, "");
  } catch {
    baseName = null;
  }
  const slug = slugify(baseName || title || "track");
  const filename = `${slug || "track"}.mp3`;
  const absPath = join(config.paths.musicDir, filename);
  const repoRelativePath = `music/${filename}`;

  const res = await fetch(contentUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download audio file (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(absPath));

  return { absPath, filePath: repoRelativePath };
}
