import { query, queryOne } from "../db/pool.js";

export async function insertMediaItem({
  projectId,
  kind,
  originalFilename,
  storedPath,
  mimeType,
  fileSizeBytes,
  width,
  height,
  durationSeconds,
  checksumSha256,
}) {
  const result = await query(
    `INSERT INTO media_items
       (project_id, kind, original_filename, stored_path, mime_type, file_size_bytes,
        width, height, duration_seconds, checksum_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE original_filename = original_filename`, // no-op on dedup, id is fetched below
    [
      projectId,
      kind,
      originalFilename,
      storedPath,
      mimeType,
      fileSizeBytes,
      width ?? null,
      height ?? null,
      durationSeconds ?? null,
      checksumSha256,
    ],
  );
  // insertId is 0 on the ON DUPLICATE KEY no-op path — look the row up by its unique key.
  if (result.insertId) return getMediaItem(result.insertId);
  return queryOne("SELECT * FROM media_items WHERE project_id = ? AND checksum_sha256 = ?", [
    projectId,
    checksumSha256,
  ]);
}

export async function getMediaItem(id) {
  return queryOne("SELECT * FROM media_items WHERE id = ?", [id]);
}

export async function listByProject(projectId) {
  return query("SELECT * FROM media_items WHERE project_id = ? ORDER BY uploaded_at ASC", [projectId]);
}

export async function countByProject(projectId) {
  const row = await queryOne("SELECT COUNT(*) AS n FROM media_items WHERE project_id = ?", [projectId]);
  return row.n;
}
