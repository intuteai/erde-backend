const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

describe('RBAC – Permission Drift Safety', () => {
  let adminToken;
  let roleId;

  beforeAll(async () => {
    // Admin login
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    adminToken = adminRes.body.token;

    // Get admin role_id
    const roleRes = await db.query(
      `SELECT role_id FROM roles WHERE role_name = 'admin' LIMIT 1`
    );
    roleId = roleRes.rows[0].role_id;

    // 🔧 CRITICAL FIX:
    // Ensure permission is ENABLED before test starts
    await db.query(
      `
      UPDATE permissions
      SET can_read = true
      WHERE role_id = $1
        AND module = 'vehicles'
      `,
      [roleId]
    );
  });

  it(
    'should revoke access after permission removal once RBAC cache expires',
    async () => {
      /* =========================
         STEP 1: Access must work
      ========================= */
      const before = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(before.statusCode).toBe(200);

      /* =========================
         STEP 2: Revoke permission
      ========================= */
      await db.query(
        `
        UPDATE permissions
        SET can_read = false
        WHERE role_id = $1
          AND module = 'vehicles'
        `,
        [roleId]
      );

      /* =========================
         STEP 3: Wait for RBAC cache expiry
         (TTL = 60s)
      ========================= */
      await new Promise(resolve => setTimeout(resolve, 61000));

      /* =========================
         STEP 4: SAME JWT must fail
      ========================= */
      const after = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(after.statusCode).toBe(403);

      /* =========================
         STEP 5: Restore permission
      ========================= */
      await db.query(
        `
        UPDATE permissions
        SET can_read = true
        WHERE role_id = $1
          AND module = 'vehicles'
        `,
        [roleId]
      );
    },
    70000 // Jest timeout > RBAC TTL
  );

  afterAll(async () => {
    await db.closePool();
  });
});
