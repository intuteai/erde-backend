// socket.io.js
const logger = require("./utils/logger");  // ← Use your existing logger
const socketAuth = require("./middleware/socketAuth");

module.exports = function initSocketIO(io) {
  /* =========================
     AUTH MIDDLEWARE
  ========================= */
  io.use(socketAuth);

  /* =========================
     CONNECTION HANDLER (Root Namespace)
  ========================= */
  io.on("connection", (socket) => {
    logger.info(
      `Socket.IO connected: ${socket.id} | User ID: ${socket.user?.user_id || "unknown"} | Username: ${socket.user?.username || "N/A"}`
    );

    /* =========================
       VEHICLE SUBSCRIPTION
    ========================= */
    socket.on("subscribe_vehicle", ({ vehicleId }) => {
      if (!vehicleId) {
        logger.warn(`subscribe_vehicle called without vehicleId from socket ${socket.id}`);
        return;
      }

      const room = `vehicle:${vehicleId}`;
      socket.join(room);
      logger.info(`Socket ${socket.id} subscribed to room: ${room}`);
    });

    /* =========================
       DISCONNECT
    ========================= */
    socket.on("disconnect", (reason) => {
      logger.info(`Socket.IO disconnected: ${socket.id} | Reason: ${reason}`);
    });
  });
};