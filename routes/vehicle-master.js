// routes/vehicle-master.js
const express = require('express');
const router = express.Router();
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

// -------------------------------------------------------------------
// 1. GET /api/vehicle-master      → Admin: ALL vehicles
//    GET /api/vehicle-master/my   → Customer: ONLY their vehicles
// -------------------------------------------------------------------
router.get(
  '/',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT 
          vm.vehicle_master_id,
          vm.vehicle_unique_id,
          vm.vehicle_reg_no,
          vm.date_of_deployment,
          vt.make AS vehicle_make,
          vt.model AS vehicle_model,
          cm.company_name,
          -- VCU: Use vcu_hmi_master if linked, else fallback to vehicle_master
          COALESCE(vhm.vcu_make || ' ' || vhm.vcu_model, vm.vcu_make_model, '—') AS vcu_display,
          -- HMI: Same logic
          COALESCE(vhm.hmi_make || ' ' || vhm.hmi_model, vm.hmi_make_model, '—') AS hmi_display
        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        LEFT JOIN vcu_hmi_master vhm ON vm.vcu_hmi_id = vhm.vcu_hmi_id
        ORDER BY vm.vehicle_master_id
      `);
      res.json(result.rows);
    } catch (err) {
      logger.error('GET /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.get(
  '/my',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    const userId = req.user.user_id;
    try {
      const custRes = await db.query(
        `SELECT customer_id FROM customer_master WHERE user_id = $1`,
        [userId]
      );
      if (custRes.rows.length === 0) {
        return res.status(404).json({ error: 'Customer profile not found' });
      }
      const customerId = custRes.rows[0].customer_id;

      const result = await db.query(
        `SELECT 
           vm.vehicle_master_id,
           vm.vehicle_unique_id,
           vm.vehicle_reg_no,
           vm.date_of_deployment,
           vt.make AS vehicle_make,
           vt.model AS vehicle_model,
           cm.company_name,
           COALESCE(vhm.vcu_make || ' ' || vhm.vcu_model, vm.vcu_make_model, '—') AS vcu_display,
           COALESCE(vhm.hmi_make || ' ' || vhm.hmi_model, vm.hmi_make_model, '—') AS hmi_display
         FROM vehicle_master vm
         JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
         JOIN customer_master cm ON vm.customer_id = cm.customer_id
         LEFT JOIN vcu_hmi_master vhm ON vm.vcu_hmi_id = vhm.vcu_hmi_id
         WHERE vm.customer_id = $1
         ORDER BY vm.vehicle_master_id`,
        [customerId]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error('GET /vehicle-master/my error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -------------------------------------------------------------------
// 2. POST /api/vehicle-master   → Admin only
// -------------------------------------------------------------------
router.post(
  '/',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const {
      vehicle_unique_id,
      customer_id,
      vtype_id,
      vcu_hmi_id,
      vehicle_reg_no,
      date_of_deployment
    } = req.body;

    if (!vehicle_unique_id || !customer_id || !vtype_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const result = await db.query(
        `INSERT INTO vehicle_master 
         (vehicle_unique_id, customer_id, vtype_id, vcu_hmi_id, vehicle_reg_no, date_of_deployment)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vehicle_unique_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           vtype_id = EXCLUDED.vtype_id,
           vcu_hmi_id = EXCLUDED.vcu_hmi_id,
           vehicle_reg_no = EXCLUDED.vehicle_reg_no,
           date_of_deployment = EXCLUDED.date_of_deployment
         RETURNING vehicle_master_id`,
        [
          vehicle_unique_id,
          customer_id,
          vtype_id,
          vcu_hmi_id || null,
          vehicle_reg_no || null,
          date_of_deployment || null
        ]
      );
      res.status(201).json({ id: result.rows[0].vehicle_master_id });
    } catch (err) {
      logger.error('POST /vehicle-master error:', err.message);
      if (err.code === '23505') {
        return res.status(400).json({ error: 'Vehicle with this unique ID already exists' });
      }
      res.status(500).json({ error: 'Failed to create vehicle' });
    }
  }
);

// -------------------------------------------------------------------
// 3. PUT /api/vehicle-master/:id   → Admin only
// -------------------------------------------------------------------
router.put(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['vehicle_reg_no', 'date_of_deployment', 'vcu_hmi_id'];
    const setParts = [];
    const values = [];
    let paramIndex = 1;

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        setParts.push(`${key} = $${paramIndex}`);
        values.push(fields[key]);
        paramIndex++;
      }
    }

    if (setParts.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    const setClause = setParts.join(', ');

    try {
      const result = await db.query(
        `UPDATE vehicle_master 
         SET ${setClause}, updated_at = NOW()
         WHERE vehicle_master_id = $${paramIndex}
         RETURNING vehicle_master_id`,
        values
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ message: 'Updated successfully' });
    } catch (err) {
      logger.error('PUT /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

// -------------------------------------------------------------------
// 4. DELETE /api/vehicle-master/:id   → Admin only
// -------------------------------------------------------------------
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'delete'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const liveCheck = await db.query(
        `SELECT 1 FROM live_values WHERE vehicle_master_id = $1 LIMIT 1`,
        [id]
      );
      if (liveCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Cannot delete: vehicle has live data' });
      }

      const result = await db.query(
        `DELETE FROM vehicle_master WHERE vehicle_master_id = $1 RETURNING vehicle_master_id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ message: 'Vehicle deleted successfully' });
    } catch (err) {
      logger.error('DELETE /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  }
);

module.exports = router;