// Phase 3: Gemini as DIRECTOR. One call over ALL the footage that returns a
// culled, ordered edit plan (opener → build → closer) + a punchy hook line +
// optional per-shot captions + a mood. Our engine still owns timing (cuts snap
// to the music beat) and rendering; Gemini decides WHAT plays and IN WHAT ORDER.
//
// Best-effort: with no key, too few shots, or any failure it returns null and
// the caller falls back to the heuristic order — so this never blocks a render.
import sharp from "sharp";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { generateJson } from "./geminiVision.js";

const DIRECTOR_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string" },
    mood: { type: "string" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          role: { type: "string", enum: ["opener", "highlight", "closer"] },
          caption: { type: "string" },
        },
        required: ["index", "role"],
      },
    },
  },
  required: ["hook", "shots"],
};

function directorPrompt(n, seconds) {
  return `You are an award-winning YouTube Shorts director and editor.
I'm giving you ${n} images labelled "Clip 0" … "Clip ${n - 1}" — frames from a festival's photos and video clips. Plan a ${seconds}-second vertical (9:16) highlights reel.

How THIS engine works, so plan within it:
- The reel is cut to the music beat. You choose WHICH clips and their ORDER — not durations.
- Cull hard: drop blurry, dull, badly-lit, repetitive or weak shots. Fewer strong shots beats more weak ones.
- Order for retention: OPEN on the single most eye-catching shot (role "opener"); build energy through the middle (role "highlight"); END on a satisfying shot (role "closer").
- For each selected clip give: its index, its role, and an OPTIONAL on-screen caption (max 4 words, punchy — omit when a shot needs none).
- "hook": a 2-5 word bold on-screen opening line for the first ~1.5s.
- "mood": one or two words (e.g. "high-energy", "warm nostalgic").

Respond with JSON only. Use each clip index at most once. Select roughly ${Math.max(8, Math.round(seconds * 0.7))}-${n} clips.`;
}

// shots: [{ index, id, framePath, kind }]. Returns { hook, mood, order:[{id,role}],
// captions:{id:text} } or null.
export async function directEdit(shots, { durationSeconds }) {
  if (!config.ai.geminiKey || shots.length < 3) return null;

  const parts = [{ text: directorPrompt(shots.length, durationSeconds) }];
  let embedded = 0;
  for (let i = 0; i < shots.length; i++) {
    let data;
    try {
      // Downscale to keep the payload/token cost sane; rotate() honours EXIF.
      data = (await sharp(shots[i].framePath).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer()).toString("base64");
    } catch (err) {
      logger.warn({ err: err.message, index: i }, "director: frame prep failed — skipping clip");
      continue;
    }
    parts.push({ text: `Clip ${i}:` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data } });
    embedded++;
  }
  if (embedded < 3) return null;

  const plan = await generateJson(parts, DIRECTOR_SCHEMA, { timeoutMs: 120_000 });
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) return null;

  const seen = new Set();
  const order = [];
  const captions = {};
  for (const s of plan.shots) {
    const shot = shots[s.index];
    if (!shot || seen.has(shot.id)) continue; // invalid or duplicate index
    seen.add(shot.id);
    order.push({ id: shot.id, role: s.role === "opener" || s.role === "closer" ? s.role : "highlight" });
    if (typeof s.caption === "string" && s.caption.trim()) captions[shot.id] = s.caption.slice(0, 40).trim();
  }
  if (order.length < 3) return null;

  logger.info(
    { selected: order.length, of: shots.length, mood: plan.mood, hook: plan.hook },
    "gemini director plan",
  );
  return {
    hook: typeof plan.hook === "string" ? plan.hook.slice(0, 40).trim() : null,
    mood: typeof plan.mood === "string" ? plan.mood.slice(0, 40) : null,
    order,
    captions,
  };
}
