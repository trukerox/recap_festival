// Background worker: handles "grab this Pixabay URL" requests forwarded by
// content-app.js (from the app's "Download via extension" button).
//
// Flow: open the Pixabay track URL in a hidden background tab (a real page load
// in your logged-in browser, which passes the bot check the server can't) →
// read the schema.org AudioObject JSON-LD → fetch the mp3 → POST it to
// festival_recap's /api/music/upload → close the tab.
//
// Same shape as the job_search extension's background.js.

const APP_BASE = "https://festival_recap.homeserver.fritz.box";
const api = globalThis.browser ?? globalThis.chrome;

const HOST_PERMS = {
  origins: [
    "https://festival_recap.homeserver.fritz.box/*",
    "https://pixabay.com/*",
    "https://cdn.pixabay.com/*",
  ],
};

const LOAD_TIMEOUT_MS = 20000;
const RENDER_WAIT_MS = 1500; // let the page settle so the JSON-LD is present
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Injected into the Pixabay tab (runs in page context).
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
          contentUrl: j.contentUrl || null,
        };
      }
    } catch {
      // ignore unparseable JSON-LD blocks
    }
  }
  return null;
}

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

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    api.tabs.onUpdated.addListener(listener);
    setTimeout(done, LOAD_TIMEOUT_MS);
  });
}

async function grabTrack(url, genre) {
  if (!/^https:\/\/pixabay\.com\/music\//.test(url || "")) {
    return { ok: false, error: "Not a Pixabay music track URL (expected pixabay.com/music/…)." };
  }
  // Host permissions are optional in Firefox MV3 — if the user hasn't granted
  // them yet, the tab/fetch calls fail opaquely. Give a clear instruction.
  if (api.permissions && !(await api.permissions.contains(HOST_PERMS))) {
    return { ok: false, error: "Grant site permissions first: click the extension's toolbar icon once and choose Allow." };
  }

  let tab;
  try {
    tab = await api.tabs.create({ url, active: false });
    await waitForLoad(tab.id);
    await sleep(RENDER_WAIT_MS);

    const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readTrackFromPage });
    const meta = injected?.[0]?.result;
    if (!meta || !meta.contentUrl) {
      return { ok: false, error: "Couldn't read track data from that page. Is it a single-track page?" };
    }

    const audioRes = await fetch(meta.contentUrl);
    if (!audioRes.ok) return { ok: false, error: `Audio download failed: HTTP ${audioRes.status}` };
    const blob = await audioRes.blob();

    const form = new FormData();
    form.append("audio", blob, filenameFrom(meta.contentUrl, meta.title));
    form.append("title", meta.title || "Untitled");
    form.append("genre", genre || guessGenre(meta.title));
    if (meta.artist) form.append("artist", meta.artist);
    form.append("sourceUrl", url);
    form.append("license", meta.license);

    const up = await fetch(`${APP_BASE}/api/music/upload`, { method: "POST", body: form });
    if (!up.ok) return { ok: false, error: `Upload failed: ${await up.text()}` };
    return { ok: true, track: await up.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tab) {
      try {
        await api.tabs.remove(tab.id);
      } catch {
        // already gone
      }
    }
  }
}

api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "grab-track") return grabTrack(msg.url, msg.genre);
  return false;
});
