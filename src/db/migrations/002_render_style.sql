-- 002_render_style — record which style preset each render used (see
-- src/services/styles.js). Lets the Videos tab show the look, and keeps the
-- edit reproducible/auditable.
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS style VARCHAR(32) NULL;
