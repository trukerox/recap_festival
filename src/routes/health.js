import { Router } from "express";
import { pool } from "../db/pool.js";
import config from "../config/index.js";
import { geminiEnabled } from "../services/geminiVision.js";
import { notifyEnabled } from "../services/notify.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up" });
  } catch {
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

// Non-secret runtime config the frontend reads (e.g. to label the button with
// the real target duration rather than a hardcoded number).
healthRouter.get("/config", (_req, res) => {
  // aiTagging / notify let you confirm the Gemini key and Telegram credentials
  // actually loaded into the container (vs the feature silently staying off).
  res.json({
    renderDurationSeconds: config.render.durationSeconds,
    aiTagging: geminiEnabled(),
    notify: notifyEnabled(),
  });
});

export default healthRouter;
