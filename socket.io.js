const socketAuth = require("./middleware/socketAuth");

module.exports = function initSocketIO(io) {
  /* =========================
     AUTH MIDDLEWARE
  ========================= */
  io.use(socketAuth);

  /* =========================
     CONNECTION HANDLER
  ========================= */
  io.on("connection", (socket) => {
    console.log(
      "Socket.IO connected:",
      socket.id,
      "user:",
      socket.user?.user_id
    );

    /* =========================
       VEHICLE SUBSCRIPTION
    ========================= */
    socket.on("subscribe_vehicle", ({ vehicleId }) => {
      if (!vehicleId) return;

      socket.join(`vehicle:${vehicleId}`);
      console.log(
        `Socket ${socket.id} subscribed to vehicle:${vehicleId}`
      );
    });

    socket.on("disconnect", () => {
      console.log("Socket.IO disconnected:", socket.id);
    });
  });
};
