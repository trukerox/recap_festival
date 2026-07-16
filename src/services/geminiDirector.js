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
          // Enum-locked so the model can't request effects the renderer doesn't
          // have (an open field invites "3D page peel" / "glitch datamosh").
          effect: { type: "string", enum: ["none", "slowmo"] },
        },
        required: ["index", "role"],
      },
    },
  },
  required: ["hook", "shots"],
};

function directorPrompt(n, seconds) {
  return `You are an award-winning YouTube Shorts director and editor.
I'm giving you ${n} clips labelled "Clip 0" … "Clip ${n - 1}" from a festival — photos (one frame each) and VIDEO clips (marked with their length, shown as up to three frames: start → action peak → end). Plan a ${seconds}-second vertical (9:16) highlights reel.

How THIS engine works, so plan within it:
- The reel is cut to the music beat. You choose WHICH clips and their ORDER — not durations.
- Cull hard: drop blurry, dull, badly-lit, repetitive or weak shots. Fewer strong shots beats more weak ones.
- Order for retention: OPEN on the single most eye-catching shot (role "opener"); build energy through the middle (role "highlight"); END on a satisfying shot (role "closer").
- For each selected clip give: its index, its role, and an OPTIONAL on-screen caption (max 4 words, punchy — omit when a shot needs none).
- "effect": VIDEO clips only. "slowmo" plays the moment at half speed for drama — reserve it for at most 2 genuinely strong MOTION moments (a jump, confetti, a crowd surge); everything else "none". Photos are always "none". Only "none" and "slowmo" exist — any other value crashes the renderer.
- "hook": the bold on-screen opening line. 2-4 words, MAX 18 CHARACTERS — it's set huge, and a longer hook has to shrink to fit, which kills its impact. "BREZELFEST 2026" or "BEST NIGHT EVER", not "Festival Fun Unleashed!".
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
    const shot = shots[i];
    const framePaths = Array.isArray(shot.framePaths) ? shot.framePaths : [shot.framePath];
    const images = [];
    for (const fp of framePaths) {
      try {
        // Downscale to keep the payload/token cost sane; rotate() honours EXIF.
        images.push(
          (await sharp(fp).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer()).toString("base64"),
        );
      } catch (err) {
        logger.warn({ err: err.message, index: i }, "director: frame prep failed — skipping frame");
      }
    }
    if (!images.length) continue;
    // Metadata label (the "media pool" idea): the director should KNOW which
    // clips are videos and how long they run — it can't tell from stills alone,
    // and slowmo only makes sense on real motion.
    const label =
      shot.kind === "video"
        ? `Clip ${i} (VIDEO, ${Math.max(1, Math.round(shot.durationSeconds || 0))}s, frames start→peak→end):`
        : `Clip ${i} (photo):`;
    parts.push({ text: label });
    for (const data of images) parts.push({ inline_data: { mime_type: "image/jpeg", data } });
    embedded++;
  }
  if (embedded < 3) return null;

  const plan = await generateJson(parts, DIRECTOR_SCHEMA, { timeoutMs: 120_000 });
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) return null;

  const seen = new Set();
  const order = [];
  const captions = {};
  const effects = {};
  for (const s of plan.shots) {
    const shot = shots[s.index];
    if (!shot || seen.has(shot.id)) continue; // invalid or duplicate index
    seen.add(shot.id);
    order.push({ id: shot.id, role: s.role === "opener" || s.role === "closer" ? s.role : "highlight" });
    if (typeof s.caption === "string" && s.caption.trim()) captions[shot.id] = s.caption.slice(0, 40).trim();
    // Belt-and-braces despite the schema enum: slowmo only, and only on videos.
    if (s.effect === "slowmo" && shot.kind === "video") effects[shot.id] = "slowmo";
  }
  if (order.length < 3) return null;

  logger.info(
    { selected: order.length, of: shots.length, mood: plan.mood, hook: plan.hook, slowmo: Object.keys(effects).length },
    "gemini director plan",
  );
  return {
    hook: typeof plan.hook === "string" ? plan.hook.slice(0, 40).trim() : null,
    mood: typeof plan.mood === "string" ? plan.mood.slice(0, 40) : null,
    order,
    captions,
    effects,
  };
}
