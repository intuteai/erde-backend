// routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/postgres');
const logger = require('../utils/logger');
require('dotenv').config();

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await db.query(
      `SELECT u.user_id, u.email, u.password_hash, u.name, r.role_name
       FROM users u
       JOIN roles r ON u.role_id = r.role_id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      logger.warn(`Login failed: email not found - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn(`Login failed: wrong password - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, role: user.role_name, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info(`Login success: ${user.email} (${user.role_name})`);
    res.json({ token, user: { name: user.name, email: user.email, role: user.role_name } });
  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;