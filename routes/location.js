const express = require("express");
const router = express.Router();
const logger = require("../utils/logger");
const { insertVehicleLocation } = require("../services/locationService");

// POST /api/location
router.post("/", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.TELEMETRY_API_KEY) {
      logger.warn(`Unauthorized /api/location access from ${req.ip}`);
      return res.status(401).json({ error: "Invalid API key" });
    }

    const { vehicle_master_id, location } = req.body;

    // Basic payload validation (route-level only)
    if (!vehicle_master_id || typeof vehicle_master_id !== "number") {
      return res.status(400).json({ error: "Invalid or missing vehicle_master_id" });
    }

    if (!location || typeof location !== "object") {
      return res.status(400).json({ error: "Missing location object" });
    }

    const { lat, lon, ts } = location;

    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      typeof ts !== "string"
    ) {
      return res.status(400).json({
        error: "Location must include lat (number), lon (number), ts (ISO string)",
      });
    }

    logger.info("[/api/location] Location received", {
      vehicle_master_id,
      lat,
      lon,
      ts,
    });

    await insertVehicleLocation({
      vehicle_master_id,
      location,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error("[/api/location] Error", {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
