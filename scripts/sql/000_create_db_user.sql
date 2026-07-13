-- Run ONCE as MariaDB root on the shared Pi `mariadb` container to provision
-- the isolated database + user for festival_recap. Replace the password with
-- the value you put in secrets/db_password.txt.
--
--   docker exec -i mariadb mariadb -uroot -p < scripts/sql/000_create_db_user.sql
--
-- The user is scoped to the festival_recap database only — no access to any
-- other database on the shared instance (evestival_app, job_search, etc.).

CREATE DATABASE IF NOT EXISTS festival_recap
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'festival_recap'@'%' IDENTIFIED BY 'REPLACE_WITH_DB_PASSWORD';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON festival_recap.* TO 'festival_recap'@'%';

FLUSH PRIVILEGES;
