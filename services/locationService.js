const db = require("../config/postgres");
const logger = require("../utils/logger");

/**
 * Insert a single vehicle location into vehicle_location table
 *
 * @param {Object} params
 * @param {number} params.vehicle_master_id
 * @param {Object} params.location
 */
const insertVehicleLocation = async ({ vehicle_master_id, location }) => {
  const {
    lat,
    lon,
    ts,
    accuracy_m,
    speed_mps,
    heading_deg,
    alt_m,
  } = location;

  // ---- Basic validation (service-level, stricter than route) ----
  if (
    typeof vehicle_master_id !== "number" ||
    vehicle_master_id <= 0
  ) {
    throw new Error("Invalid vehicle_master_id");
  }

  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    Number.isNaN(lat) ||
    Number.isNaN(lon)
  ) {
    throw new Error("Invalid latitude or longitude");
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error("Latitude or longitude out of range");
  }

  if (!ts || typeof ts !== "string") {
    throw new Error("Invalid or missing location timestamp");
  }

  // ---- Insert ----
  const client = await db.getClient();
  try {
    await client.query(
      `
      INSERT INTO vehicle_location (
        vehicle_master_id,
        recorded_at,
        lat,
        lon,
        accuracy_m,
        speed_mps,
        heading_deg,
        alt_m,
        source
      )
      VALUES (
        $1,
        $2::timestamptz,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        'app'
      )
      `,
      [
        vehicle_master_id,
        ts,
        lat,
        lon,
        accuracy_m ?? null,
        speed_mps ?? null,
        heading_deg ?? null,
        alt_m ?? null,
      ]
    );

    logger.info("[location] Location stored", {
      vehicle_master_id,
      lat,
      lon,
      ts,
    });
  } catch (err) {
    logger.error("[location] Failed to store location", {
      vehicle_master_id,
      message: err.message,
      code: err.code,
      detail: err.detail,
    });
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  insertVehicleLocation,
};
