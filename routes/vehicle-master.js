const express = require('express');
const router = express.Router();
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

/* ============================================================
   1. GET /api/vehicle-master  (Admin → all vehicles)
============================================================ */
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
          vm.vehicle_type,
          vm.customer_id,
          vm.vtype_id,
          vm.vcu_id,
          vm.hmi_id,

          vm.vcu_make_model,
          vm.hmi_make_model,
          vm.motor_make_model,
          vm.controller_make_model,
          vm.battery_make_model,
          vm.dc_dc_make_model,
          vm.btms_make_model,

          vm.hyd_cooling_yesno,
          vm.motor_controller_details,

          vm.compressor_yesno,
          vm.compressor_details,
          vm.motor_cooling_yesno,
          vm.motor_cooling_details,

          vm.date_of_deployment,
          vm.created_at,
          vm.updated_at,

          vt.make  AS vehicle_make,
          vt.model AS vehicle_model,
          cm.company_name,

          v.vcu_make,
          v.vcu_model,
          h.hmi_make,
          h.hmi_model
        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        LEFT JOIN vcu_master v ON vm.vcu_id = v.vcu_id
        LEFT JOIN hmi_master h ON vm.hmi_id = h.hmi_id
        ORDER BY vm.vehicle_master_id
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error('GET /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   2. GET /api/vehicle-master/my  (Customer vehicles)
============================================================ */
router.get(
  '/my',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    try {
      const custRes = await db.query(
        `SELECT customer_id FROM customer_master WHERE user_id = $1`,
        [req.user.user_id]
      );

      if (!custRes.rows.length) {
        return res.status(404).json({ error: 'Customer profile not found' });
      }

      const customerId = custRes.rows[0].customer_id;

      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_unique_id,
          vm.vehicle_reg_no,
          vm.vehicle_type,
          vm.vcu_id,
          vm.hmi_id,
          vm.date_of_deployment,

          vt.make AS vehicle_make,
          vt.model AS vehicle_model,
          cm.company_name,

          v.vcu_make,
          v.vcu_model,
          h.hmi_make,
          h.hmi_model
        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        LEFT JOIN vcu_master v ON vm.vcu_id = v.vcu_id
        LEFT JOIN hmi_master h ON vm.hmi_id = h.hmi_id
        WHERE vm.customer_id = $1
        ORDER BY vm.vehicle_master_id
      `, [customerId]);

      res.json(result.rows);
    } catch (err) {
      logger.error('GET /vehicle-master/my error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   3. POST /api/vehicle-master  (Admin)
============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const {
      vehicle_unique_id,
      customer_id,
      vtype_id,
      vcu_id,
      hmi_id,
      vehicle_reg_no,
      vehicle_type,

      vcu_make_model,
      hmi_make_model,
      motor_make_model,
      controller_make_model,
      battery_make_model,
      dc_dc_make_model,
      btms_make_model,

      hyd_cooling_yesno,
      motor_controller_details,

      compressor_yesno,
      compressor_details,
      motor_cooling_yesno,
      motor_cooling_details,

      date_of_deployment
    } = req.body;

    if (!vehicle_unique_id || !customer_id || !vtype_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const result = await db.query(`
        INSERT INTO vehicle_master (
          vehicle_unique_id,
          customer_id,
          vtype_id,
          vcu_id,
          hmi_id,
          vehicle_reg_no,
          vehicle_type,

          vcu_make_model,
          hmi_make_model,
          motor_make_model,
          controller_make_model,
          battery_make_model,
          dc_dc_make_model,
          btms_make_model,

          hyd_cooling_yesno,
          motor_controller_details,

          compressor_yesno,
          compressor_details,
          motor_cooling_yesno,
          motor_cooling_details,

          date_of_deployment,
          created_by
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11,$12,$13,$14,
          $15,$16,
          $17,$18,$19,$20,
          $21,$22
        )
        RETURNING vehicle_master_id
      `, [
        vehicle_unique_id,
        customer_id,
        vtype_id,
        vcu_id || null,
        hmi_id || null,
        vehicle_reg_no || null,
        vehicle_type || null,

        vcu_make_model || null,
        hmi_make_model || null,
        motor_make_model || null,
        controller_make_model || null,
        battery_make_model || null,
        dc_dc_make_model || null,
        btms_make_model || null,

        hyd_cooling_yesno ?? null,
        motor_controller_details || null,

        compressor_yesno ?? null,
        compressor_details || null,
        motor_cooling_yesno ?? null,
        motor_cooling_details || null,

        date_of_deployment || null,
        req.user.user_id
      ]);

      res.status(201).json({ id: result.rows[0].vehicle_master_id });
    } catch (err) {
      logger.error('POST /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Failed to create vehicle' });
    }
  }
);

/* ============================================================
   4. PUT /api/vehicle-master/:id
============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const allowed = [
      'vehicle_reg_no',
      'vehicle_type',
      'vcu_id',
      'hmi_id',
      'motor_make_model',
      'controller_make_model',
      'battery_make_model',
      'dc_dc_make_model',
      'btms_make_model',
      'hyd_cooling_yesno',
      'motor_controller_details',
      'compressor_yesno',
      'compressor_details',
      'motor_cooling_yesno',
      'motor_cooling_details',
      'date_of_deployment'
    ];

    const updates = [];
    const values = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${i}`);
        values.push(req.body[key]);
        i++;
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.id);

    try {
      const result = await db.query(`
        UPDATE vehicle_master
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE vehicle_master_id = $${i}
      `, values);

      if (!result.rowCount) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('PUT /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

/* ============================================================
   5. DELETE /api/vehicle-master/:id
============================================================ */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'delete'),
  async (req, res) => {
    try {
      const liveCheck = await db.query(
        `SELECT 1 FROM live_values WHERE vehicle_master_id = $1 LIMIT 1`,
        [req.params.id]
      );

      if (liveCheck.rows.length) {
        return res.status(400).json({ error: 'Cannot delete: vehicle has live data' });
      }

      const result = await db.query(
        `DELETE FROM vehicle_master WHERE vehicle_master_id = $1`,
        [req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('DELETE /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  }
);

module.exports = router;
