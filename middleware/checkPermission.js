// middleware/checkPermission.js
const db = require('../config/postgres');
const logger = require('../utils/logger');

/**
 * Middleware: Check if user has permission for a module + action
 * 
 * Usage:
 *   router.get('/live', authenticateToken, checkPermission('live_view', 'read'), handler);
 *   router.post('/config', authenticateToken, checkPermission('config', 'write'), handler);
 * 
 * @param {string} module - e.g., 'live_view', 'analytics', 'config', 'faults'
 * @param {string} action - 'read', 'write', 'delete'
 */
const checkPermission = (module, action) => {
  return async (req, res, next) => {
    const userId = req.user?.user_id;
    const role = req.user?.role;

    if (!userId) {
      logger.warn('Permission denied: No user_id in JWT');
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    if (!['read', 'write', 'delete'].includes(action)) {
      logger.error(`Invalid action: ${action}`);
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    try {
      // Query permission from DB
      const result = await db.query(
        `SELECT p.can_read, p.can_write, p.can_delete
         FROM permissions p
         JOIN users u ON p.role_id = u.role_id
         WHERE u.user_id = $1 AND p.module = $2`,
        [userId, module]
      );

      if (result.rows.length === 0) {
        logger.warn(`No permission entry for user ${userId} on module ${module}`);
        return res.status(403).json({ error: 'Forbidden: No access to this module' });
      }

      const perm = result.rows[0];
      const hasAccess = perm[`can_${action}`];

      if (!hasAccess) {
        logger.warn(`Access denied: ${role} tried to ${action} ${module}`);
        return res.status(403).json({ 
          error: 'Forbidden: Insufficient permissions',
          required: `${action}_${module}`,
          current_role: role
        });
      }

      logger.info(`Permission granted: ${role} → ${action} ${module}`);
      next();

    } catch (err) {
      logger.error(`Permission check failed for user ${userId}: ${err.message}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

module.exports = checkPermission;