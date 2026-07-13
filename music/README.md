# Music library

This service does **not** call a music API at render time — it picks from a
small curated local library instead. That avoids adding an external
dependency/rate-limit to the render path and keeps licensing unambiguous.

## Adding tracks — via the Music tab (recommended)

Open the **Music** tab in the web UI, paste a `pixabay.com/music/...` track
URL, click **Preview**. The server scrapes the title/artist/duration/license
from Pixabay's page metadata and shows an editable form — confirm/adjust the
**genre** and **BPM** (neither is published anywhere, so these are always a
starting guess, never scraped fact) and click **Download & add track**. The
server downloads the mp3 straight into `music/` and adds the DB row itself —
no FileZilla, no manual JSON editing.

Only `pixabay.com/music/...` links are understood right now (see
`src/services/musicImport.js`). Anything else falls back to the manual path
below. If Pixabay ever blocks the Pi's requests (bot protection, layout
changes), you'll get a clear error from the Preview step and should also fall
back to the manual path.

Implementation: `src/services/musicImport.js` (scrape + download),
`src/routes/music.js` (`GET /api/music/preview`, `POST /api/music/import`).

## Adding tracks — manual / bulk path

Useful for bulk-loading many tracks at once, non-Pixabay sources, or if
auto-import breaks.

1. Source royalty-free tracks. [YouTube Audio Library](https://studio.youtube.com)
   has no public download API, so tracks must be downloaded manually through
   the YouTube Studio UI; check each track's license type (some require
   attribution) before adding it here.
2. Drop the audio files into this `music/` folder (mp3, ideally ≥ 20s long —
   the composer trims to the render's total duration).
3. Add one entry per track to `library.json` (title, artist, genre, **bpm**,
   duration_seconds, `file_path` **relative to the repo root** — e.g.
   `"music/my_track.mp3"`, not just `"my_track.mp3"` — license, source_url).
4. Run `node scripts/seed-music.js` to load `library.json` into the
   `music_tracks` table (idempotent — re-running updates existing rows by
   `file_path`, doesn't duplicate them; shares the same upsert logic as the
   Music-tab import, see `src/repositories/musicTracks.js`).

## On the Pi

Both paths write into the same place: `music/` is **bind-mounted, not baked
into the image** (see `docker-compose.yml`) — the container always reads
whatever is at `~/docker/festival_recap/music/` on the host, and the
Music-tab import writes there directly since it runs inside the container.
For the manual path, mp3s are gitignored — `git pull` will never bring them
in, so FileZilla/scp them onto the Pi directly if you're not using the
Music-tab import.

## Licensing

Keep the `license` and `source_url` fields filled in for every track — that's
your paper trail if a video ever gets flagged on a platform for the audio
track. Don't add anything whose license is unclear.
