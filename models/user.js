const pool = require("../config/db");

class User {
  static async findByEmail(email) {
    try {
      const result = await pool.query(
        "SELECT * FROM users WHERE email = $1 LIMIT 1",
        [email]
      );
      console.log("Database query result for email:", email, result.rows); // Debug log
      return result.rows[0];
    } catch (err) {
      console.error("Database query error:", err);
      throw err;
    }
  }

  static async updatePassword(email, newHash) {
    try {
      const result = await pool.query(
        "UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING *",
        [newHash, email]
      );
      console.log("Password updated for email:", email, result.rows[0]); // Debug log
      return result.rows[0];
    } catch (err) {
      console.error("Password update error:", err);
      throw err;
    }
  }
}

module.exports = User;