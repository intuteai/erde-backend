const pool = require('../config/db');

class User {
  static async findByEmail(email) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1 LIMIT 1',
        [email]
      );
      console.log('Database query result for email:', email, result.rows); // Debug log
      return result.rows[0];
    } catch (err) {
      console.error('Database query error:', err);
      throw err;
    }
  }
}

module.exports = User;