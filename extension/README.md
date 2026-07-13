# festival_recap track grabber (browser extension)

One-click "add this track to festival_recap" from a Pixabay music page.

## Why it exists

festival_recap's server **cannot** download Pixabay tracks: Pixabay sits
behind Cloudflare-style bot protection that returns HTTP 403 to any
server-side request (verified even with full browser headers from a
residential IP). This extension runs in **your** logged-in browser — which
passes that check — reads the track's metadata off the page, downloads the
mp3 in the browser, and uploads the file to festival_recap's normal
`/api/music/upload` endpoint. The server never talks to Pixabay.

Same idea as the job_search JD-fetcher extension: use the real browser to get
what the server can't.

## How it works

1. Browse to any single-track page on Pixabay (`pixabay.com/music/…`).
2. Click the extension's toolbar icon → pick a genre (or leave "Auto") →
   **Add current track**.
3. The extension reads the page's schema.org `AudioObject` metadata
   (title, artist, license, source URL, direct mp3 URL), fetches the mp3
   bytes in the browser, and POSTs the file + metadata to festival_recap.
4. The server auto-detects BPM from the audio and adds it to the library —
   check the app's **Music** tab.

Nothing is downloaded to your disk and no JSON is typed by hand.

## Install (temporary / development, Firefox)

1. In Firefox, go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this `extension/` folder.

Temporary add-ons are removed when Firefox restarts. For a permanent install,
sign it via addons.mozilla.org, or use Developer/ESR Firefox with
`xpinstall.signatures.required` disabled.

(On Chromium: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select this folder. The code uses a `browser`/`chrome` fallback,
but it's primarily tested against Firefox, matching the job_search extension.)

## Configuration

The app URL is hard-coded as `https://festival_recap.homeserver.fritz.box` in
`popup.js` (`APP_BASE`) and `manifest.json` (`host_permissions`). If your URL
differs, edit both. Because the app uses `tls internal` (self-signed cert),
your browser must already trust it — visiting the site once and accepting the
cert is enough; the extension reuses the browser's trust store.

## Security note

festival_recap has no auth (LAN-only, behind Caddy `tls internal`), so the
upload endpoint is open on your LAN — the extension needs no token. This
matches the rest of the service's posture. Don't expose festival_recap to the
public internet without adding an auth layer first.
