import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import config from "./config/index.js";
import logger from "./utils/logger.js";
import pool from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { projectsRouter } from "./routes/projects.js";
import { jobsRouter } from "./routes/jobs.js";
import { musicRouter } from "./routes/music.js";
import { referenceRouter } from "./routes/reference.js";
import { startWorkerLoop } from "./queue/worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

for (const dir of [config.paths.uploadDir, config.paths.renderDir, config.paths.tmpDir, config.paths.referenceDir]) {
  mkdirSync(dir, { recursive: true });
}

const app = express();
app.set("trust proxy", 1); // behind Caddy
app.use(helmet({ contentSecurityPolicy: false })); // CSP handled at Caddy
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/music", musicRouter);
app.use("/api/reference", referenceRouter);

app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, "index.html")));

app.use(errorHandler);

async function start() {
  await runMigrations();

  // The render worker runs as a poll loop inside this same process (see
  // src/queue/worker.js) — there is no separate queue container. This keeps
  // a single Pi-hosted service instead of adding Redis/BullMQ for a workload
  // that is CPU-bound on one box anyway.
  const stopWorker = startWorkerLoop();

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env, aiTagging: Boolean(config.ai.geminiKey), geminiModel: config.ai.geminiModel },
      "festival_recap listening",
    );
  });

  const shutdown = (sig) => {
    logger.info({ sig }, "shutting down");
    stopWorker();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error({ err }, "failed to start");
  process.exit(1);
});
