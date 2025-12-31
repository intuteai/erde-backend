// routes/auth.js - SAFE VERSION (USE THIS ONE)
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/postgres');
const logger = require('../utils/logger');
require('dotenv').config();

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    logger.info(`Login attempt for email: ${email}`);

    // Step 1: Get user
    const userResult = await db.query(
      'SELECT user_id, email, password_hash, name, role_id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`Login failed: User not found - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Step 2: Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      logger.warn(`Login failed: Invalid password - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Step 3: Get role name safely
    let roleName = 'customer';
    try {
      const roleResult = await db.query(
        'SELECT role_name FROM roles WHERE role_id = $1',
        [user.role_id]
      );
      if (roleResult.rows.length > 0) {
        roleName = roleResult.rows[0].role_name;
      }
    } catch (e) {
      logger.warn(`Role lookup failed for user ${email}: ${e.message}`);
    }

    // Step 4: Get customer_id safely
    let customerId = null;
    try {
      const custResult = await db.query(
        'SELECT customer_id FROM customer_master WHERE user_id = $1 LIMIT 1',
        [user.user_id]
      );
      customerId = custResult.rows[0]?.customer_id || null;
    } catch (e) {
      logger.debug(`customer_master lookup skipped for ${email}`);
    }

    // Step 5: Generate token
    const token = jwt.sign(
      {
        user_id: user.user_id,
        email: user.email,
        role: roleName,
        name: user.name || email.split('@')[0],
        customer_id: customerId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info(`Login SUCCESS: ${email} (role: ${roleName})`);

    res.json({
      token,
      user: {
        name: user.name || email.split('@')[0],
        email: user.email,
        role: roleName,
        customer_id: customerId,
      },
    });
  } catch (err) {
    logger.error(`CRITICAL Login error for ${email}: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;