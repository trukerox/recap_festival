// Phase 2: Gemini vision tagging for smarter shot selection.
//
// The local heuristic scorer (sharpness/faces/motion) can't tell a striking
// "hero" moment from a dull one. Gemini looks at each image and returns a
// shot_type + a hero/quality rating, which we blend into the composite score so
// the reel leads with the best moments. Entirely OPTIONAL: with no API key
// configured, tagImage() returns null and the pipeline uses heuristics only.
//
// Privacy note: this uploads each analysed image to Google's Gemini API.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import config from "../config/index.js";
import logger from "../utils/logger.js";

const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const PROMPT = `You are curating the best moments for a 30-second festival highlights reel.
Analyse this single image and respond with JSON only.
- shot_type: "close" (one or two people/subjects filling the frame), "wide" (a crowd or the whole scene), or "detail" (an object/food/texture close-up with few or no people).
- hero: 0.0-1.0 — how striking, emotional and share-worthy this is as a highlight moment.
- quality: 0.0-1.0 — technical quality (sharp and well-exposed = high; blurry, dark or dull = low).
- subject: a 2-4 word description (e.g. "crowd at stage", "grilled food", "kids on carousel").`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    shot_type: { type: "string", enum: ["close", "wide", "detail"] },
    hero: { type: "number" },
    quality: { type: "number" },
    subject: { type: "string" },
  },
  required: ["shot_type", "hero", "quality"],
};

export function geminiEnabled() {
  return Boolean(config.ai.geminiKey);
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));

// Model names/versions drift and vary by key, so instead of hard-coding one
// (which 404s if the key can't see it) we ask the API which models this key can
// actually use and pick a flash-class one. Resolved once per process.
//   undefined = not tried yet, null = none available, string = the model name.
let resolvedModel;
async function resolveModel() {
  if (resolvedModel !== undefined) return resolvedModel;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.ai.geminiKey}`);
    if (!res.ok) {
      logger.warn({ status: res.status }, "gemini ListModels failed — AI tagging disabled");
      resolvedModel = null;
      return null;
    }
    const data = await res.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""));
    // Some listed models are tombstones (e.g. gemini-2.0-flash "no longer
    // available") — 404 on use. Prefer current 2.5 flash (lite first = cheapest
    // for bulk tagging) and never fall back to the old 1.0/1.5/2.0 names.
    const stable = (n) => !/(exp|thinking|preview)/i.test(n);
    const notOld = (n) => !/gemini-(1\.0|1\.5|2\.0)/i.test(n);
    const pick =
      (config.ai.geminiModel && names.find((n) => n === config.ai.geminiModel)) || // explicit override only
      names.find((n) => /2\.5-flash-lite/i.test(n) && stable(n)) ||
      names.find((n) => /2\.5-flash/i.test(n) && stable(n)) ||
      names.find((n) => /flash-lite/i.test(n) && stable(n) && notOld(n)) ||
      names.find((n) => /flash/i.test(n) && stable(n) && notOld(n)) ||
      names.find((n) => stable(n) && notOld(n)) || // any current model that can generate
      null;
    resolvedModel = pick;
    logger.info({ model: pick, availableCount: names.length }, "gemini model resolved");
    return pick;
  } catch (err) {
    logger.warn({ err: err.message }, "gemini ListModels error — AI tagging disabled");
    resolvedModel = null;
    return null;
  }
}

// Returns { shotType, hero, quality, subject } or null (no key / any failure —
// caller falls back to heuristics, so tagging is always best-effort).
export async function tagImage(imagePath) {
  if (!config.ai.geminiKey) return null;

  const model = await resolveModel();
  if (!model) return null;

  let b64;
  try {
    b64 = (await readFile(imagePath)).toString("base64");
  } catch {
    return null;
  }
  const mime = MIME_BY_EXT[extname(imagePath).toLowerCase()] || "image/jpeg";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.2, response_mime_type: "application/json", response_schema: RESPONSE_SCHEMA },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`${url}?key=${config.ai.geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.warn({ status: res.status, model, body: errBody.slice(0, 400) }, "gemini tag request failed");
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    const st = parsed.shot_type;
    return {
      shotType: st === "close" || st === "wide" || st === "detail" ? st : null,
      hero: Number.isFinite(parsed.hero) ? clamp01(parsed.hero) : 0.5,
      quality: Number.isFinite(parsed.quality) ? clamp01(parsed.quality) : 0.5,
      subject: typeof parsed.subject === "string" ? parsed.subject.slice(0, 60) : null,
    };
  } catch (err) {
    logger.warn({ err: err.message }, "gemini tag error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
