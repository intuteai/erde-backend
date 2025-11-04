// routes/vehicleMaster.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vehicles_master';

// GET ALL VEHICLES - NOW RETURNS **EVERY FIELD**!
router.get('/', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         vm.vehicle_master_id,
         vm.vehicle_unique_id,
         vm.vehicle_reg_no,
         cm.company_name,
         vt.make,
         vt.model,
         vh.vcu_make,
         vh.hmi_make,
         vm.vcu_make_model,
         vm.hmi_make_model,
         vm.motor_make_model,
         vm.controller_make_model,
         vm.battery_make_model,
         vm.dc_dc_make_model,
         vm.btms_make_model,
         vm.hyd_cooling_yesno,
         vm.motor_controller_details,
         vm.date_of_deployment,
         vm.created_at,
         vm.updated_at
       FROM vehicle_master vm
       JOIN customer_master cm ON vm.customer_id = cm.customer_id
       JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
       LEFT JOIN vcu_hmi_master vh ON vm.vcu_hmi_id = vh.vcu_hmi_id
       ORDER BY vm.vehicle_unique_id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /vehicles-master error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE - FULL FIELDS
router.post('/', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const {
    vehicle_unique_id, customer_id, vtype_id, vcu_hmi_id,
    vehicle_reg_no, vehicle_type, vcu_make_model, hmi_make_model,
    motor_make_model, controller_make_model, battery_make_model,
    dc_dc_make_model, btms_make_model, hyd_cooling_yesno,
    motor_controller_details, date_of_deployment
  } = req.body;

  if (!vehicle_unique_id || !customer_id || !vtype_id) {
    return res.status(400).json({ error: 'vehicle_unique_id, customer_id, vtype_id required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO vehicle_master (
        vehicle_unique_id, customer_id, vtype_id, vcu_hmi_id,
        vehicle_reg_no, vehicle_type, vcu_make_model, hmi_make_model,
        motor_make_model, controller_make_model, battery_make_model,
        dc_dc_make_model, btms_make_model, hyd_cooling_yesno,
        motor_controller_details, date_of_deployment, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING vehicle_master_id`,
      [
        vehicle_unique_id, customer_id, vtype_id, vcu_hmi_id || null,
        vehicle_reg_no || null, vehicle_type || null, vcu_make_model || null, hmi_make_model || null,
        motor_make_model || null, controller_make_model || null, battery_make_model || null,
        dc_dc_make_model || null, btms_make_model || null, hyd_cooling_yesno || false,
        motor_controller_details || null, date_of_deployment || null, req.user.user_id
      ]
    );
    logger.info(`Vehicle created: ${vehicle_unique_id}`);
    res.status(201).json({ vehicle_master_id: result.rows[0].vehicle_master_id });
  } catch (err) {
    logger.error(`POST /vehicles-master error: ${err.message}`);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Vehicle unique ID already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// UPDATE - FULL FIELDS
router.put('/:id', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const { id } = req.params;
  const fields = req.body;
  const allowed = [
    'customer_id', 'vtype_id', 'vcu_hmi_id', 'vehicle_reg_no', 'vehicle_type',
    'vcu_make_model', 'hmi_make_model', 'motor_make_model', 'controller_make_model',
    'battery_make_model', 'dc_dc_make_model', 'btms_make_model', 'hyd_cooling_yesno',
    'motor_controller_details', 'date_of_deployment'
  ];

  const updates = [];
  const values = [];
  let i = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${i}`);
      values.push(fields[key]);
      i++;
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(id);
  try {
    const result = await db.query(
      `UPDATE vehicle_master 
       SET ${updates.join(', ')}, updated_at = NOW() 
       WHERE vehicle_master_id = $${i}
       RETURNING vehicle_master_id`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vehicle not found' });
    logger.info(`Vehicle updated: ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`PUT /vehicles-master/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE - SAFE
router.delete('/:id', authenticateToken, checkPermission(MODULE, 'delete'), async (req, res) => {
  const { id } = req.params;
  try {
    const check = await db.query(`SELECT 1 FROM vehicle_live_data WHERE vehicle_master_id = $1 LIMIT 1`, [id]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: 'Cannot delete: Vehicle has live telemetry' });
    }

    const result = await db.query(`DELETE FROM vehicle_master WHERE vehicle_master_id = $1 RETURNING vehicle_master_id`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vehicle not found' });
    
    logger.info(`Vehicle deleted: ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /vehicles-master/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;