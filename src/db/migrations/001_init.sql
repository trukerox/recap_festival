-- 001_init — core schema for festival_recap
-- Charset utf8mb4 throughout. JSON columns used for flexible list/struct fields.

CREATE TABLE IF NOT EXISTS projects (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_name      VARCHAR(255) NOT NULL,
  location        VARCHAR(255),
  event_date      DATE NULL,
  music_style     VARCHAR(32),        -- electronic|edm|festival|pop|cinematic|auto
  watermark_path  VARCHAR(512) NULL,  -- logo uploaded alongside media, if any
  cta_text        VARCHAR(255) NOT NULL DEFAULT 'Want more festivals?\nVisit evestival.com',
  status           VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft|ready|archived
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media_items (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id        INT UNSIGNED NOT NULL,
  kind              VARCHAR(8) NOT NULL,   -- photo|video
  original_filename VARCHAR(255) NOT NULL,
  stored_path       VARCHAR(512) NOT NULL,
  mime_type         VARCHAR(64) NOT NULL,
  file_size_bytes   BIGINT UNSIGNED NOT NULL,
  width             INT UNSIGNED NULL,
  height            INT UNSIGNED NULL,
  duration_seconds  DECIMAL(6,2) NULL,     -- video only
  checksum_sha256   CHAR(64) NOT NULL,
  uploaded_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_media_project_checksum (project_id, checksum_sha256),
  CONSTRAINT fk_media_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  KEY idx_media_project (project_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media_scores (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  media_item_id       INT UNSIGNED NOT NULL,
  sharpness           FLOAT NULL,          -- normalised 0..1
  brightness          FLOAT NULL,          -- normalised 0..1 (0.5 = ideal exposure)
  contrast            FLOAT NULL,          -- normalised 0..1
  face_count          SMALLINT UNSIGNED NULL,
  crowd_score         FLOAT NULL,          -- normalised 0..1, derived from face_count + frame coverage
  motion_score        FLOAT NULL,          -- video only, normalised 0..1 (frame-diff magnitude)
  shot_type           VARCHAR(8) NULL,     -- wide|close, heuristic from face size/count
  composite_score     FLOAT NULL,          -- weighted final score used for selection
  is_selected         TINYINT(1) NOT NULL DEFAULT 0,
  selected_order      SMALLINT UNSIGNED NULL,   -- position in the final timeline
  trim_start_seconds  DECIMAL(6,2) NULL,        -- video only: best segment start
  trim_end_seconds    DECIMAL(6,2) NULL,        -- video only: best segment end
  analyzed_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_score_media (media_item_id),
  CONSTRAINT fk_score_media FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS music_tracks (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  artist           VARCHAR(255),
  genre            VARCHAR(32) NOT NULL,  -- electronic|edm|festival|pop|cinematic
  bpm              SMALLINT UNSIGNED NOT NULL,
  duration_seconds DECIMAL(6,2) NOT NULL,
  file_path        VARCHAR(512) NOT NULL,
  license          VARCHAR(64) NOT NULL,  -- e.g. "Pixabay Content License", "CC0"
  source_url       VARCHAR(512),
  active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_music_genre (genre, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS render_jobs (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id       INT UNSIGNED NOT NULL,
  music_track_id   INT UNSIGNED NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'queued', -- queued|analyzing|selecting|rendering|done|failed
  progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
  output_path      VARCHAR(512) NULL,
  error_message     TEXT NULL,
  queued_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at       DATETIME NULL,
  finished_at      DATETIME NULL,
  CONSTRAINT fk_job_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_music FOREIGN KEY (music_track_id) REFERENCES music_tracks(id) ON DELETE SET NULL,
  KEY idx_job_status (status, queued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
