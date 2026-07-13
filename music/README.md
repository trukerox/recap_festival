# Music library

This service does **not** call a music API at render time — it picks from a
small curated local library instead. That avoids adding an external
dependency/rate-limit to the render path and keeps licensing unambiguous
(each track's license is recorded once, up front, in `library.json`).

## How to add tracks

1. Source ~20-30 royalty-free tracks across the 5 genres the brief asks for
   (`electronic`, `edm`, `festival`, `pop`, `cinematic`). Good sources:
   - [Pixabay Music](https://pixabay.com/music/) — free, no attribution required
     (Pixabay Content License), has a genre/mood filter and BPM shown per track.
   - YouTube Audio Library — no public download API, so tracks must be
     downloaded manually through the YouTube Studio UI; check each track's
     license type (some require attribution) before adding it here.
2. Drop the audio files into this `music/` folder (mp3, ideally ≥ 20s long —
   the composer trims to the render's total duration).
3. Add one entry per track to `library.json` (title, artist, genre, **bpm**,
   duration_seconds, file_path relative to this folder, license, source_url).
   The BPM matters — it's what the beat-synced cut timing in
   `src/services/selection.js` snaps to.
4. Run `node scripts/seed-music.js` to load `library.json` into the
   `music_tracks` table (idempotent — re-running updates existing rows by
   `file_path`, doesn't duplicate them).

## Licensing

Keep the `license` and `source_url` fields filled in for every track — that's
your paper trail if a video ever gets flagged on a platform for the audio
track. Don't add anything whose license is unclear.
