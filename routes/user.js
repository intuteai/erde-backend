// routes/user.js
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// POST /api/user/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const userId = req.user.user_id;

  // Input validation
  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'All password fields are required' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'New passwords do not match' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }

  try {
    logger.info(`Password change request for user ID: ${userId}`);

    // Fetch current password hash
    const result = await db.query(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      logger.warn(`Password change failed: User not found (ID: ${userId})`);
      return res.status(404).json({ error: 'User not found' });
    }

    const { password_hash: currentHash } = result.rows[0];

    // Verify current password
    const isCurrentValid = await bcrypt.compare(current_password, currentHash);
    if (!isCurrentValid) {
      logger.warn(`Password change failed: Incorrect current password (User ID: ${userId})`);
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Prevent reusing the same password
    const isSameAsCurrent = await bcrypt.compare(new_password, currentHash);
    if (isSameAsCurrent) {
      return res.status(400).json({ error: 'New password cannot be the same as current password' });
    }

    // Hash new password (same strength: 12 rounds)
    const saltRounds = 12;
    const newHash = await bcrypt.hash(new_password, saltRounds);

    // Update password — REMOVED updated_at since column doesn't exist
    await db.query(
      'UPDATE users SET password_hash = $1 WHERE user_id = $2',
      [newHash, userId]
    );

    logger.info(`Password successfully updated for user ID: ${userId}`);

    return res.json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error(`Password change error for user ${userId}: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Failed to update password' });
  }
});

module.exports = router;