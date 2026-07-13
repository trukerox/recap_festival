// Bridge between the festival_recap web app and this extension.
//
// Injected only on the app's own domain. The app's "Download via extension"
// button can't talk to the extension directly (isolated worlds), so it
// window.postMessage()s a request; this content script forwards it to the
// background script (which opens the Pixabay page, grabs the mp3, uploads it)
// and posts the result back for the page to display.
//
// Same pattern as the job_search extension's content-app.js.

const api = globalThis.browser ?? globalThis.chrome;

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "festivalrecap-app" || data.type !== "grab") return;

  let result;
  try {
    result = await api.runtime.sendMessage({ type: "grab-track", url: data.url, genre: data.genre });
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  window.postMessage({ source: "festivalrecap-ext", type: "grab-result", result }, "*");
});

// Let the page know the extension is present (so the app can enable its button
// and show a helpful message if it's missing).
window.postMessage({ source: "festivalrecap-ext", type: "ready" }, "*");
