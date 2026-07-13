import { pino } from "pino";
import config from "../config/index.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? "info" : "debug"),
  base: { service: "festival_recap" },
  redact: ["req.headers.authorization", "req.headers.cookie", "password", "*.password"],
});

export default logger;
