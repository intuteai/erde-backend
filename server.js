// server.js
const http = require("http");
const app = require("./app");
const logger = require("./utils/logger");

/* =========================
   TRUST PROXY
========================= */
app.set("trust proxy", true);

/* =========================
   INIT MODULES
========================= */
// Raw WS from AWS → DB → cache invalidation → SSE clients get fresh data
const initRawWebSocket = require("./config/socket");

const PORT = process.env.SERVER_PORT || 5000;

/* =========================
   HTTP SERVER
========================= */
const server = http.createServer(app);

/* =========================
   REGISTER REALTIME LAYERS
========================= */
// Only pass server — app is no longer needed (we removed Socket.IO dependency)
initRawWebSocket(server);

/* =========================
   START SERVER
========================= */
server.listen(PORT, "0.0.0.0", () => {
  logger.info(`EV Dashboard Backend LIVE on http://0.0.0.0:${PORT}`);
});

/* =========================
   GRACEFUL SHUTDOWN
========================= */
process.on("SIGTERM", () => {
  logger.warn("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.warn("SIGINT received. Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});