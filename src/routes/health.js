import { Router } from "express";
import { pool } from "../db/pool.js";
import config from "../config/index.js";
import { geminiEnabled } from "../services/geminiVision.js";

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
  // aiTagging lets you confirm the Gemini key actually loaded into the container.
  res.json({ renderDurationSeconds: config.render.durationSeconds, aiTagging: geminiEnabled() });
});

export default healthRouter;
