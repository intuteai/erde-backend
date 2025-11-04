// routes/customer.js
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'customers';

// GET ALL — NOW WITH EMAIL & USER_NAME!
router.get('/', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         c.customer_id, c.company_name, c.address, c.contact_person, c.phone,
         c.invoicing_details, c.created_at, c.updated_at,
         u.user_id, u.email, u.name as user_name
       FROM customer_master c
       LEFT JOIN users u ON c.user_id = u.user_id
       ORDER BY c.company_name`
    );
    logger.info(`Fetched ${result.rows.length} customers`);
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /customers error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE — WITH USER ACCOUNT
router.post('/', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const {
    company_name, address, contact_person, phone, invoicing_details,
    email, password, name
  } = req.body;

  if (!company_name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'Company name, email, and password required' });
  }

  try {
    await db.query('BEGIN');

    // Get customer role
    const roleRes = await db.query(`SELECT role_id FROM roles WHERE role_name = 'customer'`);
    if (roleRes.rows.length === 0) throw new Error('Customer role not found');

    // Create user
    const hash = await bcrypt.hash(password, 10);
    const userRes = await db.query(
      `INSERT INTO users (role_id, name, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING user_id`,
      [roleRes.rows[0].role_id, name?.trim() || company_name.trim(), email.trim(), hash]
    );

    // Create customer
    const custRes = await db.query(
      `INSERT INTO customer_master (
        user_id, company_name, address, contact_person, phone, 
        invoicing_details, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) 
       RETURNING customer_id`,
      [
        userRes.rows[0].user_id,
        company_name.trim(),
        address?.trim() || null,
        contact_person?.trim() || null,
        phone?.trim() || null,
        invoicing_details?.trim() || null,
        req.user.user_id
      ]
    );

    await db.query('COMMIT');
    logger.info(`Customer created: ${company_name} (${email}) by ${req.user.email}`);
    res.status(201).json({ 
      customer_id: custRes.rows[0].customer_id,
      message: "Customer & login created!"
    });
  } catch (err) {
    await db.query('ROLLBACK');
    const msg = err.message.includes('users_email_key') 
      ? 'Email already exists' 
      : 'Server error';
    logger.error(`POST /customers error: ${err.message}`);
    res.status(400).json({ error: msg });
  }
});

// UPDATE
router.put('/:id', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const { id } = req.params;
  const { company_name, address, contact_person, phone, invoicing_details } = req.body;

  const updates = [];
  const values = [];
  let i = 1;

  if (company_name !== undefined) { updates.push(`company_name = $${i++}`); values.push(company_name.trim()); }
  if (address !== undefined) { updates.push(`address = $${i++}`); values.push(address?.trim() || null); }
  if (contact_person !== undefined) { updates.push(`contact_person = $${i++}`); values.push(contact_person?.trim() || null); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone?.trim() || null); }
  if (invoicing_details !== undefined) { updates.push(`invoicing_details = $${i++}`); values.push(invoicing_details?.trim() || null); }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(id);
  try {
    const result = await db.query(
      `UPDATE customer_master 
       SET ${updates.join(', ')}, updated_at = NOW(), updated_by = $${i}
       WHERE customer_id = $${i + 1}
       RETURNING customer_id`,
      [...values, req.user.user_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true, message: "Updated!" });
  } catch (err) {
    logger.error(`PUT /customers/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE — NOW DELETES USER TOO!
router.delete('/:id', authenticateToken, checkPermission(MODULE, 'delete'), async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');

    // Get user_id
    const custRes = await db.query(
      `SELECT user_id FROM customer_master WHERE customer_id = $1`, [id]
    );
    if (custRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer not found' });
    }

    const userId = custRes.rows[0].user_id;

    // Delete customer
    await db.query(`DELETE FROM customer_master WHERE customer_id = $1`, [id]);

    // Delete user (if exists)
    if (userId) {
      await db.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    }

    await db.query('COMMIT');
    logger.info(`Customer & user deleted: ID ${id}`);
    res.json({ success: true, message: "Customer & login deleted!" });
  } catch (err) {
    await db.query('ROLLBACK');
    logger.error(`DELETE /customers/${id} error: ${err.message}`);
    res.status(400).json({ 
      error: err.message.includes('vehicles_master_customer_id_fkey')
        ? 'Cannot delete: Customer has vehicles assigned'
        : 'Delete failed'
    });
  }
});

module.exports = router;