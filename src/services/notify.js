// Telegram "render done" ping.
//
// A render takes 3-5 minutes, so sitting on the tab waiting is tedious — more so
// from a phone. This pings when a job finishes (or fails) instead.
//
// Entirely OPTIONAL and strictly best-effort: with no credentials, or on any
// error, it logs and returns. A notification must NEVER fail or delay a render,
// so every call site fires it without awaiting the result.
//
// Credentials come from Docker secrets: telegram_bot_token + telegram_chat_id.
import config from "../config/index.js";
import logger from "../utils/logger.js";

export function notifyEnabled() {
  return Boolean(config.notify.telegramToken && config.notify.telegramChatId);
}

async function send(text) {
  if (!notifyEnabled()) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.notify.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.notify.telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200) }, "telegram notify failed");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "telegram notify error");
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyRenderDone({ jobId, eventName, style, seconds }) {
  await send(
    `✅ Recap #${jobId} ready\n` +
      `${eventName || "Untitled"}${style ? ` · ${style}` : ""}\n` +
      `Rendered in ${seconds}s\n` +
      `${config.publicBaseUrl}/`,
  );
}

export async function notifyRenderFailed({ jobId, eventName, error }) {
  await send(
    `❌ Recap #${jobId} failed\n` +
      `${eventName || "Untitled"}\n` +
      `${String(error || "unknown error").slice(0, 300)}`,
  );
}
