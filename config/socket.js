// config/socket.js
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { parseCanDataWithDB } = require("../services/dbParser");
const db = require("../config/postgres");
const { formatLiveData } = require("../utils/formatLiveData");
require("dotenv").config();

/**
 * Initialize Raw WebSocket Server for /aws-ws
 * Bridges parsed CAN data → DB → formatted broadcast to Socket.IO frontend
 */
const initWebSocket = (server, app) => {
  const wss = new WebSocket.Server({ noServer: true });
  const awsWsPool = new Map();

  /* ============================================================
     HTTP → WS UPGRADE HANDLING
  ============================================================ */
  server.on("upgrade", (req, socket, head) => {
    const { url } = req;

    // Let Socket.IO handle its own upgrades
    if (url.startsWith("/socket.io")) return;

    const path = url.split("?")[0];
    if (path !== "/aws-ws") {
      logger.warn(`Rejected invalid WS upgrade attempt: ${url}`);
      socket.destroy();
      return;
    }

    logger.info(`Raw WS upgrade accepted: ${url}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  /* ============================================================
     RAW WS CONNECTION
  ============================================================ */
  wss.on("connection", async (ws, req) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return ws.close(4000, "Invalid URL");
    }

    const token = url.searchParams.get("token");
    const deviceId = url.searchParams.get("device_id") || "VCL001";

    if (!token) return ws.close(4001, "Token missing");

    try {
      ws.user = jwt.verify(token, process.env.JWT_SECRET);
      ws.deviceId = deviceId;
      logger.info(`Raw WS connected: ${ws.user.username} → ${deviceId}`);
    } catch {
      return ws.close(4002, "Invalid token");
    }

    /* ============================================================
       DEVICE → VEHICLE MAPPING
    ============================================================ */
    let vehicleMasterId;
    try {
      const res = await db.query(
        `SELECT vehicle_master_id
         FROM vehicle_master
         WHERE vehicle_unique_id = $1`,
        [deviceId]
      );

      if (!res.rows.length) return ws.close(4004, "Vehicle not found");

      vehicleMasterId = res.rows[0].vehicle_master_id;
      ws.vehicleMasterId = vehicleMasterId;
    } catch (err) {
      logger.error(`DB error during WS connect: ${err.message}`);
      return ws.close(5000, "Server error");
    }

    /* ============================================================
       AWS WS CONNECTION (ONE PER DEVICE)
    ============================================================ */
    let awsWs = awsWsPool.get(deviceId);

    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) {
      awsWs = new WebSocket(
        `${process.env.AWS_WS_URL}?device_id=${deviceId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.AWS_API_KEY}`,
          },
          handshakeTimeout: 15000,
        }
      );

      awsWs.on("open", () => {
        awsWs.send(JSON.stringify({ action: "subscribe", device_id: deviceId }));
        logger.info(`AWS WS connected & subscribed: ${deviceId}`);
      });

      /* ============================================================
         AWS MESSAGE HANDLER
      ============================================================ */
      awsWs.on("message", async (data) => {
        try {
          const raw = JSON.parse(data.toString());
          const payloadHex = raw.payload || raw.items?.[0]?.payload;
          if (!payloadHex) return;

          const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

          /* ============================================================
             DB UPSERT (FIELD-PRESERVING)
          ============================================================ */
          const keys = Object.keys(parsed).filter(
            (k) => !["timestamp", "fault_code", "fault_description"].includes(k)
          );

          if (keys.length) {
            const columns = ["vehicle_master_id", "recorded_at", ...keys];
            const values = [vehicleMasterId, new Date(), ...keys.map((k) => parsed[k])];
            const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

            const updates = keys
              .map((k) => `${k} = COALESCE(EXCLUDED.${k}, live_values.${k})`)
              .join(", ");

            await db.query(
              `
              INSERT INTO live_values (${columns.join(", ")})
              VALUES (${placeholders})
              ON CONFLICT (vehicle_master_id)
              DO UPDATE SET
                recorded_at = EXCLUDED.recorded_at,
                ${updates}
              `,
              values
            );
          }

          /* ============================================================
             DTC LOGGING
          ============================================================ */
          if (parsed.fault_code) {
            await db.query(
              `
              INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT DO NOTHING
              `,
              [
                vehicleMasterId,
                parsed.fault_code,
                parsed.fault_description || "Unknown",
              ]
            );
          }

          /* ============================================================
             SOCKET.IO BROADCAST (AUTHORITATIVE FROM DB)
          ============================================================ */
          const io = app.get("io");
          if (!io) return;

          const latest = await db.query(
            `
            SELECT *
            FROM live_values
            WHERE vehicle_master_id = $1
            ORDER BY recorded_at DESC
            LIMIT 1
            `,
            [vehicleMasterId]
          );

          if (latest.rows.length) {
            const formatted = formatLiveData(latest.rows[0]);
            io.to(`vehicle:${vehicleMasterId}`).emit("live_update", formatted);
          }
        } catch (err) {
          logger.error(`AWS message processing failed: ${err.message}`);
        }
      });

      awsWs.on("close", () => awsWsPool.delete(deviceId));
      awsWs.on("error", () => awsWsPool.delete(deviceId));

      awsWsPool.set(deviceId, awsWs);
    }

    /* ============================================================
       CLEANUP
    ============================================================ */
    ws.on("close", () => {
      const stillActive = [...wss.clients].some(
        (c) => c.readyState === WebSocket.OPEN && c.deviceId === deviceId
      );

      if (!stillActive && awsWs) {
        awsWs.close();
        awsWsPool.delete(deviceId);
      }
    });
  });

  return wss;
};

module.exports = initWebSocket;
