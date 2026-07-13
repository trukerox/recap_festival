# festival_recap

Self-hosted service that turns uploaded festival photos/clips into an
energetic 20-second vertical (1080x1920) recap video — for YouTube Shorts,
Instagram Reels, TikTok. Runs standalone in Docker on the Raspberry Pi
homeserver. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
design (schema, API, AI scoring approach, scaling strategy) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for how to ship new code.

**Independent project** — nothing shared with Evestival or job_search beyond
the Pi's shared `mariadb` container and `web` Docker network.

## Stack

Node 20 / Express, MariaDB (shared Pi instance, own database/user), FFmpeg
(Ken Burns + xfade transitions + color grading), `sharp` + OpenCV (via a
Python subprocess) for media scoring, a local curated royalty-free music
library. No Redis/queue service — the render worker is an in-process
DB-polling loop (see `docker-compose.yml` header for why).

## First-time deploy (Raspberry Pi)

1. `bash deploy/setup-pi.sh` — bootstrap (clone, secrets, data dir)
2. Fill `secrets/db_password.txt`
3. Create the DB + user — see `scripts/sql/000_create_db_user.sql`
4. Add royalty-free tracks under `music/` (see `music/README.md`), then
   `docker compose exec -T festival_recap node scripts/seed-music.js`
5. Append `caddy/festival_recap.caddy` to the Pi Caddyfile, reload Caddy
6. `bash deploy/update-pi.sh` — build + start
7. (optional) `bash deploy/update-pi.sh --install-cron` — daily retention cleanup

## Local development

Needs a reachable MariaDB and `ffmpeg`/`python3-opencv` on PATH (this is
designed to run inside the Docker image — see `docker/Dockerfile` for exact
package versions). Copy `.env.example` to `.env`, point `DB_HOST` at a
MariaDB instance, then:

```
npm install
npm run migrate
npm start
```

## API

See [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md#3-api-endpoints) for the
full endpoint list. Quick flow: `POST /api/projects` → `POST
/api/projects/:id/media` (upload) → `POST /api/projects/:id/render` → poll
`GET /api/jobs/:id` → `GET /api/jobs/:id/download`.

## Music

Add royalty-free tracks via the **Music** tab (upload a downloaded mp3 — the
server auto-detects BPM), or install the [browser extension](extension/) to
grab the Pixabay track you're viewing with one click. Pixabay blocks
server-side downloads (bot protection), so the file always comes from your
browser. See [music/README.md](music/README.md).

## Status

v1 baseline — functional end-to-end pipeline, not yet run against real
festival footage. Before relying on it: run a real render on the target Pi
hardware to get an actual render-time number (see ARCHITECTURE.md §8), and
tune the scoring weights in `src/services/mediaAnalysis.js` against real
photos/clips.
