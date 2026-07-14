import { query, queryOne } from "../db/pool.js";

export async function createProject({ eventName, location, eventDate, musicStyle, ctaText }) {
  const result = await query(
    `INSERT INTO projects (event_name, location, event_date, music_style, cta_text)
     VALUES (?, ?, ?, ?, COALESCE(?, DEFAULT(cta_text)))`,
    [eventName, location ?? null, eventDate ?? null, musicStyle ?? "auto", ctaText ?? null],
  );
  return getProject(result.insertId);
}

export async function getProject(id) {
  return queryOne("SELECT * FROM projects WHERE id = ?", [id]);
}

// Update editable metadata on an existing project (used when re-rendering the
// same uploaded media under a new event name / music style). Only provided
// fields are changed.
export async function updateProject(id, { eventName, location, eventDate, musicStyle }) {
  const sets = [];
  const params = [];
  if (eventName !== undefined) { sets.push("event_name = ?"); params.push(eventName); }
  if (location !== undefined) { sets.push("location = ?"); params.push(location ?? null); }
  if (eventDate !== undefined) { sets.push("event_date = ?"); params.push(eventDate ?? null); }
  if (musicStyle !== undefined) { sets.push("music_style = ?"); params.push(musicStyle ?? "auto"); }
  if (sets.length) {
    params.push(id);
    await query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return getProject(id);
}

export async function setWatermark(id, watermarkPath) {
  await query("UPDATE projects SET watermark_path = ? WHERE id = ?", [watermarkPath, id]);
}

export async function markReady(id) {
  await query("UPDATE projects SET status = 'ready' WHERE id = ?", [id]);
}
