// One-click "add this Pixabay track to festival_recap".
//
// Why this exists: festival_recap's server can't fetch Pixabay pages — Pixabay's
// Cloudflare bot protection 403s every server-side request (verified even with
// full browser headers). This extension runs in YOUR logged-in browser, which
// passes that check, so it can read the page and download the audio. It then
// uploads the file to festival_recap's normal /api/music/upload endpoint (the
// same one the web UI's upload form uses) — the server never touches Pixabay.
//
// Firefox MV3 (browser.* namespace, like the job_search extension). Also works
// on Chromium via the `chrome` fallback below.

const APP_BASE = "https://festival_recap.homeserver.fritz.box";
const api = globalThis.browser ?? globalThis.chrome;

const HOST_PERMS = {
  origins: [
    "https://festival_recap.homeserver.fritz.box/*",
    "https://pixabay.com/*",
    "https://cdn.pixabay.com/*",
  ],
};

const statusEl = document.getElementById("status");
const genreSel = document.getElementById("genre");
const addBtn = document.getElementById("add");

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? "err" : "";
}

// Firefox MV3 does not auto-grant host_permissions — they're optional and must
// be granted by the user, or scripting.executeScript + cross-site fetch fail
// with an opaque permission error. Requesting them here (from the button's
// user gesture) shows a one-time grant prompt instead of failing silently.
async function ensurePermissions() {
  if (!api.permissions) return true; // API absent (old browser) — let fetch surface the real error
  try {
    if (await api.permissions.contains(HOST_PERMS)) return true;
    return await api.permissions.request(HOST_PERMS);
  } catch (e) {
    setStatus(`Could not request site permissions: ${e.message}`, true);
    return false;
  }
}

// Injected into the active tab (runs in page context). Reads the schema.org
// AudioObject JSON-LD block Pixabay embeds per track page — the same block the
// server would read if it weren't blocked.
function readTrackFromPage() {
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b.textContent);
      if (j["@type"] === "AudioObject") {
        return {
          title: (j.name || "").replace(/\s*\|\s*Royalty-free Music\s*$/i, "").trim(),
          artist: j.creator?.name || null,
          license: "Pixabay Content License",
          sourceUrl: location.href,
          contentUrl: j.contentUrl || null,
        };
      }
    } catch {
      // ignore unparseable JSON-LD blocks
    }
  }
  return null;
}

// Client-side genre guess (mirrors the server's guessGenre) used when the
// dropdown is left on "Auto". Always overridable in the dropdown.
function guessGenre(title) {
  const t = (title || "").toLowerCase();
  if (/dubstep|edm|drum ?and ?bass|dnb|bass ?drop/.test(t)) return "edm";
  if (/electronic|synth|techno|house/.test(t)) return "electronic";
  if (/cinematic|epic|trailer|orchestral/.test(t)) return "cinematic";
  if (/\bpop\b/.test(t)) return "pop";
  return "festival";
}

function filenameFrom(contentUrl, title) {
  try {
    const f = new URL(contentUrl).searchParams.get("filename");
    if (f) return f;
  } catch {
    // fall through
  }
  return `${(title || "track").replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.mp3`;
}

addBtn.addEventListener("click", async () => {
  addBtn.disabled = true;
  try {
    setStatus("Checking permissions…");
    if (!(await ensurePermissions())) {
      setStatus("Site permissions were denied — click again and choose Allow, or grant them in about:addons → this extension → Permissions.", true);
      return;
    }

    setStatus("Reading page…");
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/pixabay\.com\/music\//.test(tab.url || "")) {
      setStatus(`This tab isn't a Pixabay track page. Open pixabay.com/music/… and click again. (current: ${tab?.url || "unknown"})`, true);
      return;
    }

    const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readTrackFromPage });
    const meta = injected?.[0]?.result;
    if (!meta || !meta.contentUrl) {
      setStatus("Couldn't find track data on this page. Is it a single-track page?", true);
      return;
    }

    setStatus("Downloading audio in your browser…");
    const audioRes = await fetch(meta.contentUrl);
    if (!audioRes.ok) {
      setStatus(`Audio download failed: HTTP ${audioRes.status}`, true);
      return;
    }
    const blob = await audioRes.blob();

    const genre = genreSel.value === "auto" ? guessGenre(meta.title) : genreSel.value;

    const form = new FormData();
    form.append("audio", blob, filenameFrom(meta.contentUrl, meta.title));
    form.append("title", meta.title || "Untitled");
    form.append("genre", genre);
    if (meta.artist) form.append("artist", meta.artist);
    form.append("sourceUrl", meta.sourceUrl);
    form.append("license", meta.license);

    setStatus("Uploading to festival_recap + detecting BPM…");
    const up = await fetch(`${APP_BASE}/api/music/upload`, { method: "POST", body: form });
    if (!up.ok) {
      setStatus(`Upload failed: ${await up.text()}`, true);
      return;
    }
    const track = await up.json();
    const conf = track.bpmConfidence != null ? ` (conf ${Math.round(track.bpmConfidence * 100)}%)` : "";
    setStatus(`Added "${track.title}" — ${track.genre}, ${track.bpm} BPM${conf}.`);
  } catch (e) {
    setStatus(`Error: ${e.message}`, true);
  } finally {
    addBtn.disabled = false;
  }
});
