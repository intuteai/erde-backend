const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'customers';

/* 🔐 DEFAULT PASSWORD (already bcrypt-hashed) */
const DEFAULT_PASSWORD_HASH =
  '$2a$10$XcmsTW5nP3mKQYQFvk7g7.DkCseqXgCxZB2Y/Kk8ExL6Kck.cRqA2';

/* =========================================================
   GET CUSTOMERS
   ADMIN     → all customers
   CUSTOMER  → only own record
========================================================= */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const isCustomer = req.user.role === 'customer';

      const result = await db.query(
        `
        SELECT 
          c.customer_id,
          c.company_name,
          c.address,
          c.contact_person,
          c.phone,
          c.created_at,
          c.updated_at,
          u.user_id,
          u.email,
          u.name AS user_name
        FROM customer_master c
        LEFT JOIN users u ON c.user_id = u.user_id
        WHERE ($1::int IS NULL OR c.user_id = $1)
        ORDER BY c.company_name
        `,
        [isCustomer ? req.user.user_id : null]
      );

      logger.info(`Fetched ${result.rows.length} customers`);
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /customers error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================================================
   CREATE CUSTOMER + LOGIN (ADMIN ONLY)
   - Email = Login ID
   - Password = DEFAULT_PASSWORD_HASH
========================================================= */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const {
      company_name,
      address,
      contact_person,
      phone,
      email,
      name,
    } = req.body;

    if (!company_name?.trim() || !email?.trim()) {
      return res.status(400).json({
        error: 'Company name and email are required',
      });
    }

    // A transaction must run on ONE connection: db.query() may pick a different pooled
    // connection per call, leaving BEGIN stranded "idle in transaction" in the pool.
    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');

      /* Get customer role */
      const roleRes = await client.query(
        `SELECT role_id FROM roles WHERE role_name = 'customer'`
      );

      if (!roleRes.rows.length) {
        throw new Error('Customer role not found');
      }

      /* Create user with DEFAULT password */
      const userRes = await client.query(
        `
        INSERT INTO users (role_id, name, email, password_hash, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING user_id
        `,
        [
          roleRes.rows[0].role_id,
          name?.trim() || company_name.trim(),
          email.trim(),
          DEFAULT_PASSWORD_HASH,
        ]
      );

      /* Create customer record */
      const custRes = await client.query(
        `
        INSERT INTO customer_master (
          user_id,
          company_name,
          address,
          contact_person,
          phone,
          created_by,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING customer_id
        `,
        [
          userRes.rows[0].user_id,
          company_name.trim(),
          address?.trim() || null,
          contact_person?.trim() || null,
          phone?.trim() || null,
          req.user.user_id,
        ]
      );

      await client.query('COMMIT');

      logger.info(
        `Customer created: ${company_name} | login=${email} | default password assigned`
      );

      res.status(201).json({
        customer_id: custRes.rows[0].customer_id,
        message: 'Customer & login created with default password',
      });
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { client.release(true); client = null; /* unknown state — discard */ }
      }

      logger.error(`POST /customers error: ${err.message}`);

      res.status(400).json({
        error: err.message.includes('unique')
          ? 'Email already exists'
          : 'Server error',
      });
    } finally {
      if (client) client.release();
    }
  }
);

/* =========================================================
   UPDATE CUSTOMER
   ADMIN     → any customer
   CUSTOMER  → only own record
========================================================= */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { id } = req.params;
    const { company_name, address, contact_person, phone } = req.body;

    try {
      /* 🔐 TENANT ISOLATION */
      if (req.user.role === 'customer') {
        const ownerCheck = await db.query(
          `
          SELECT 1
          FROM customer_master
          WHERE customer_id = $1
            AND user_id = $2
          `,
          [id, req.user.user_id]
        );

        if (!ownerCheck.rows.length) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const updates = [];
      const values = [];
      let i = 1;

      if (company_name !== undefined) {
        updates.push(`company_name = $${i++}`);
        values.push(company_name.trim());
      }

      if (address !== undefined) {
        updates.push(`address = $${i++}`);
        values.push(address?.trim() || null);
      }

      if (contact_person !== undefined) {
        updates.push(`contact_person = $${i++}`);
        values.push(contact_person?.trim() || null);
      }

      if (phone !== undefined) {
        updates.push(`phone = $${i++}`);
        values.push(phone?.trim() || null);
      }

      if (!updates.length) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(req.user.user_id, id);

      const result = await db.query(
        `
        UPDATE customer_master
        SET ${updates.join(', ')},
            updated_at = NOW(),
            updated_by = $${i}
        WHERE customer_id = $${i + 1}
        RETURNING customer_id
        `,
        values
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      res.json({ success: true, message: 'Customer updated' });
    } catch (err) {
      logger.error(`PUT /customers/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================================================
   DELETE CUSTOMER (ADMIN ONLY)
========================================================= */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    const { id } = req.params;

    // One dedicated connection for the whole transaction (see POST above).
    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');

      const custRes = await client.query(
        `SELECT user_id FROM customer_master WHERE customer_id = $1`,
        [id]
      );

      if (!custRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Customer not found' });
      }

      const userId = custRes.rows[0].user_id;

      await client.query(`DELETE FROM customer_master WHERE customer_id = $1`, [id]);

      if (userId) {
        await client.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
      }

      await client.query('COMMIT');

      logger.info(`Customer deleted: ${id}`);
      res.json({ success: true, message: 'Customer & user deleted' });
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { client.release(true); client = null; /* unknown state — discard */ }
      }

      logger.error(`DELETE /customers/${id} error: ${err.message}`);

      res.status(400).json({
        error: err.message.includes('vehicle_master_customer_id_fkey')
          ? 'Cannot delete: Customer has vehicles assigned'
          : 'Delete failed',
      });
    } finally {
      if (client) client.release();
    }
  }
);

module.exports = router;
