const pool = require('../config/db');

class VehicleWide {
  static async getByVehicleType(vehicle_type) {
    const result = await pool.query(
      `SELECT id, vehicle_id, parameter_id, value, unit, timestamp, vehicle_type, table_name, numeric_value
       FROM vehicle_wide
       WHERE vehicle_type = $1
       ORDER BY vehicle_id, timestamp`,
      [vehicle_type]
    );
    return result.rows;
  }
}

module.exports = VehicleWide;
