const pool = require('../config/db');

class MachineIdentification {
  static async getByVehicleType(vehicle_type) {
    const result = await pool.query(
      `SELECT id, vehicle_id, parameter_id, value, unit, timestamp, vehicle_type, table_name, numeric_value
       FROM machine_identification
       WHERE vehicle_type = $1
       ORDER BY vehicle_id, timestamp`,
      [vehicle_type]
    );
    return result.rows;
  }
}

module.exports = MachineIdentification;
