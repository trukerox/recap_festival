import { query, queryOne } from "../db/pool.js";

export async function upsertScore(mediaItemId, s) {
  await query(
    `INSERT INTO media_scores
       (media_item_id, sharpness, brightness, contrast, face_count, crowd_score,
        motion_score, shot_type, composite_score, trim_start_seconds, trim_end_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       sharpness = VALUES(sharpness), brightness = VALUES(brightness), contrast = VALUES(contrast),
       face_count = VALUES(face_count), crowd_score = VALUES(crowd_score),
       motion_score = VALUES(motion_score), shot_type = VALUES(shot_type),
       composite_score = VALUES(composite_score), trim_start_seconds = VALUES(trim_start_seconds),
       trim_end_seconds = VALUES(trim_end_seconds), analyzed_at = CURRENT_TIMESTAMP`,
    [
      mediaItemId,
      s.sharpness ?? null,
      s.brightness ?? null,
      s.contrast ?? null,
      s.faceCount ?? null,
      s.crowdScore ?? null,
      s.motionScore ?? null,
      s.shotType ?? null,
      s.compositeScore ?? null,
      s.trimStartSeconds ?? null,
      s.trimEndSeconds ?? null,
    ],
  );
  return getScore(mediaItemId);
}

export async function getScore(mediaItemId) {
  return queryOne("SELECT * FROM media_scores WHERE media_item_id = ?", [mediaItemId]);
}

export async function markSelection(projectId, selections) {
  // selections: [{ mediaItemId, order }]
  await query(
    `UPDATE media_scores ms
       JOIN media_items mi ON mi.id = ms.media_item_id
     SET ms.is_selected = 0, ms.selected_order = NULL
     WHERE mi.project_id = ?`,
    [projectId],
  );
  for (const { mediaItemId, order } of selections) {
    await query(
      "UPDATE media_scores SET is_selected = 1, selected_order = ? WHERE media_item_id = ?",
      [order, mediaItemId],
    );
  }
}

// Clears cached scores for a project so the next render re-analyses every item
// from scratch (e.g. after enabling Gemini tagging). Returns rows removed.
export async function deleteScoresForProject(projectId) {
  const result = await query(
    `DELETE ms FROM media_scores ms
     JOIN media_items mi ON mi.id = ms.media_item_id
     WHERE mi.project_id = ?`,
    [projectId],
  );
  return result.affectedRows ?? 0;
}

export async function listScoresForProject(projectId) {
  return query(
    `SELECT mi.*, ms.*
     FROM media_items mi
     JOIN media_scores ms ON ms.media_item_id = mi.id
     WHERE mi.project_id = ?`,
    [projectId],
  );
}
