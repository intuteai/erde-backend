const pool = require('../config/db');

class LvBattery {
  static async getByVehicleType(vehicle_type) {
    const result = await pool.query(
      `SELECT id, vehicle_id, parameter_id, value, unit, timestamp, vehicle_type, table_name, numeric_value
       FROM lv_battery
       WHERE vehicle_type = $1
       ORDER BY vehicle_id, timestamp`,
      [vehicle_type]
    );
    return result.rows;
  }
}

module.exports = LvBattery;
