// config/socket.js
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { parseCanDataWithDB } = require("../services/dbParser");
const db = require("../config/postgres");
require("dotenv").config();

const initWebSocket = (server) => {
  const wss = new WebSocket.Server({ noServer: true });
  const awsWsPool = new Map();

  /* =========================================================
     HTTP → WS UPGRADE HANDLER
     - Allow Socket.IO to handle /socket.io/* upgrades
     - Only allow raw WebSocket upgrades on /aws-ws (with or without query params)
     - Reject everything else early
  ========================================================= */
  server.on("upgrade", (req, socket, head) => {
    const { url } = req;

    // Let Socket.IO handle its own namespace
    if (url.startsWith("/socket.io")) {
      return; // Socket.IO will handle this upgrade itself
    }

    // Strict path check: only allow /aws-ws or /aws-ws?params...
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

  /* =========================================================
     RAW WEBSOCKET CONNECTION HANDLER
  ========================================================= */
  wss.on("connection", async (ws, req) => {
    // Parse URL properly (handles query params correctly)
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch (err) {
      logger.warn(`Invalid URL in WS connection: ${req.url}`);
      return ws.close(4000, "Invalid URL");
    }

    const token = url.searchParams.get("token");
    const deviceId = url.searchParams.get("device_id") || "VCL001";

    /* =========================
       JWT AUTHENTICATION
    ========================= */
    if (!token) {
      logger.warn(`WS connection rejected: Missing token (${deviceId})`);
      return ws.close(4001, "Token missing");
    }

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
      ws.user = user;
      ws.deviceId = deviceId;
      logger.info(`Raw WS connected: ${user.username} → ${deviceId}`);
    } catch (err) {
      logger.warn(`WS connection rejected: Invalid token (${deviceId}) - ${err.message}`);
      return ws.close(4002, "Invalid token");
    }

    /* =========================
       MAP DEVICE_ID → VEHICLE_MASTER_ID
    ========================= */
    let vehicleMasterId;
    try {
      const res = await db.query(
        `SELECT vehicle_master_id
         FROM vehicle_master
         WHERE vehicle_unique_id = $1`,
        [deviceId]
      );

      if (!res.rows.length) {
        logger.error(`Vehicle not found in DB: ${deviceId}`);
        return ws.close(4004, "Vehicle not found");
      }

      vehicleMasterId = res.rows[0].vehicle_master_id;
      ws.vehicleMasterId = vehicleMasterId;
    } catch (err) {
      logger.error(`Database error during WS connection: ${err.message}`);
      return ws.close(5000, "Server error");
    }

    /* =========================
       AWS WEBSOCKET CONNECTION (ONE PER DEVICE)
    ========================= */
    let awsWs = awsWsPool.get(deviceId);

    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) {
      try {
        awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
          headers: {
            Authorization: `Bearer ${process.env.AWS_API_KEY}`,
          },
          // Optional: increase timeout if AWS endpoint is slow
          handshakeTimeout: 10000,
        });

        awsWs.on("open", () => {
          awsWs.send(
            JSON.stringify({
              action: "subscribe",
              device_id: deviceId,
            })
          );
          logger.info(`AWS WS connected and subscribed: ${deviceId}`);
        });

        awsWs.on("message", async (data) => {
          try {
            const raw = JSON.parse(data.toString());
            const payloadHex = raw.payload || raw.items?.[0]?.payload;

            if (!payloadHex) {
              return; // No payload to process
            }

            const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

            /* ===== SAVE LIVE VALUES TO DB ===== */
            const keys = Object.keys(parsed).filter(
              (k) => !["timestamp", "fault_code", "fault_description"].includes(k)
            );

            if (keys.length > 0) {
              const columns = ["vehicle_master_id", "recorded_at", ...keys].join(", ");
              const values = [vehicleMasterId, new Date(), ...keys.map((k) => parsed[k])];
              const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

              await db.query(
                `
                INSERT INTO live_values (${columns})
                VALUES (${placeholders})
                ON CONFLICT (vehicle_master_id)
                DO UPDATE SET
                  ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}
                `,
                values
              );
            }

            /* ===== SAVE DTC EVENTS ===== */
            if (parsed.fault_code) {
              await db.query(
                `
                INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT DO NOTHING
                `,
                [vehicleMasterId, parsed.fault_code, parsed.fault_description || "Unknown"]
              );
            }

            /* ===== BROADCAST TO ALL CONNECTED CLIENTS FOR THIS DEVICE ===== */
            const broadcast = {
              ...parsed,
              timestamp: Date.now(),
              deviceId,
            };

            wss.clients.forEach((client) => {
              if (
                client.readyState === WebSocket.OPEN &&
                client.deviceId === deviceId
              ) {
                try {
                  client.send(JSON.stringify(broadcast));
                } catch (sendErr) {
                  logger.warn(`Failed to send to client (${deviceId}): ${sendErr.message}`);
                }
              }
            });

            logger.info(`Live data processed & broadcasted: ${deviceId}`);
          } catch (err) {
            logger.error(`Error processing AWS message (${deviceId}): ${err.message}`);
          }
        });

        awsWs.on("close", (code, reason) => {
          logger.warn(`AWS WS closed (${deviceId}) - Code: ${code}, Reason: ${reason.toString()}`);
          awsWsPool.delete(deviceId);
        });

        awsWs.on("error", (err) => {
          logger.error(`AWS WS error (${deviceId}): ${err.message}`);
          awsWsPool.delete(deviceId);
        });

        // Store in pool
        awsWsPool.set(deviceId, awsWs);
      } catch (err) {
        logger.error(`Failed to create AWS WS connection (${deviceId}): ${err.message}`);
        return ws.close(5001, "Failed to connect to data source");
      }
    }

    /* =========================
       FORWARD CLIENT MESSAGES TO AWS (e.g., commands)
    ========================= */
    ws.on("message", (msg) => {
      if (awsWs?.readyState === WebSocket.OPEN) {
        try {
          awsWs.send(msg);
        } catch (err) {
          logger.error(`Failed to forward message to AWS (${deviceId}): ${err.message}`);
        }
      }
    });

    /* =========================
       CLEANUP ON CLIENT DISCONNECT
    ========================= */
    ws.on("close", (code, reason) => {
      logger.info(
        `Raw WS client disconnected: ${ws.user?.username || "unknown"} (${deviceId}) - Code: ${code}`
      );

      // Check if any other clients are still connected to this device
      const hasActiveClients = [...wss.clients].some(
        (c) => c.readyState === WebSocket.OPEN && c.deviceId === deviceId
      );

      if (!hasActiveClients && awsWs) {
        awsWs.close();
        awsWsPool.delete(deviceId);
        logger.info(`AWS WS closed due to no active clients: ${deviceId}`);
      }
    });

    // Optional: handle sudden errors on client socket
    ws.on("error", (err) => {
      logger.warn(`Raw WS client error (${deviceId}): ${err.message}`);
    });
  });

  return wss;
};

module.exports = initWebSocket;