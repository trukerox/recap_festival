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

export async function setWatermark(id, watermarkPath) {
  await query("UPDATE projects SET watermark_path = ? WHERE id = ?", [watermarkPath, id]);
}

export async function markReady(id) {
  await query("UPDATE projects SET status = 'ready' WHERE id = ?", [id]);
}
