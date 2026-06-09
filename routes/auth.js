// routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/postgres');
const logger = require('../utils/logger');
const authenticateToken = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

const COOKIE_DEFAULTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    logger.info(`Login attempt for email: ${email}`);

    const userResult = await db.query(
      'SELECT user_id, email, password_hash, name, role_id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`Login failed: User not found - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      logger.warn(`Login failed: Invalid password - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

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

    const accessToken = jwt.sign(
      {
        user_id: user.user_id,
        email: user.email,
        role: roleName,
        name: user.name || email.split('@')[0],
        customer_id: customerId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = crypto.randomBytes(64).toString('hex');
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.user_id,
        tokenHash,
        req.headers['user-agent'] || null,
        req.ip || null,
        expiresAt,
      ]
    );

    res.cookie('access_token', accessToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    res.cookie('refresh_token', refreshToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    logger.info(`Login SUCCESS: ${email} (role: ${roleName})`);

    res.json({
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

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token missing' });
  }

  const tokenHash = hashToken(refreshToken);

  try {
    const result = await db.query(
      `SELECT rt.user_id, u.email, u.name, r.role_name, cm.customer_id
       FROM refresh_tokens rt
       JOIN users u ON u.user_id = rt.user_id
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN customer_master cm ON cm.user_id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > now()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { user_id, email, name, role_name, customer_id } = result.rows[0];

    const accessToken = jwt.sign(
      { user_id, email, role: role_name, name, customer_id },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    await db.query(
      'UPDATE refresh_tokens SET last_used_at = now() WHERE token_hash = $1',
      [tokenHash]
    );

    res.cookie('access_token', accessToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    res.json({ user: { name, email, role: role_name, customer_id } });
  } catch (err) {
    logger.error(`Refresh error: ${err.message}`);
    res.status(500).json({ error: 'Server error during token refresh' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;

  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    try {
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    } catch (err) {
      logger.warn(`Logout DB cleanup failed: ${err.message}`);
    }
  }

  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const { user_id, email, role, name, customer_id } = req.user;
  res.json({ user: { user_id, email, role, name, customer_id } });
});

module.exports = router;
