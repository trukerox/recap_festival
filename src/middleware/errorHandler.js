import logger from "../utils/logger.js";
import config from "../config/index.js";

// Central error handler. Never leaks a stack trace to clients in production.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) logger.error({ err, path: req.path }, "request failed");
  res.status(status).json({
    error: err.expose ? err.message : "Internal error",
    ...(config.isProd ? {} : { detail: err.message }),
  });
}

// Helper to throw client-facing errors with a status.
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}
