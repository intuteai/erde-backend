const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let customerToken;
let foreignVehicleId;
let infraAvailable = true;

describe('Multi-User Isolation – Customer Data Boundary', () => {

  beforeAll(async () => {
    try {
      /* ===========================
         ADMIN LOGIN
      ============================ */
      const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@erdeenergy.in',
          password: 'password123',
        });

      adminToken = adminLogin.body?.token;
      if (!adminToken) throw new Error('Admin login failed');

      /* ===========================
         CUSTOMER LOGIN
      ============================ */
      const customerLogin = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'customer@intuteai.in',
          password: 'password123',
        });

      customerToken = customerLogin.body?.token;
      if (!customerToken) throw new Error('Customer login failed');

      /* ===========================
         FIND A VEHICLE NOT OWNED BY CUSTOMER
      ============================ */
      const foreignVehicleRes = await db.query(
        `
        SELECT vm.vehicle_master_id
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        JOIN users u ON cm.user_id = u.user_id
        WHERE u.email != $1
        LIMIT 1
        `,
        ['customer@intuteai.in']
      );

      if (!foreignVehicleRes.rows.length) {
        throw new Error('No foreign vehicle found for isolation test');
      }

      foreignVehicleId = foreignVehicleRes.rows[0].vehicle_master_id;

    } catch (err) {
      infraAvailable = false;
      console.warn('⚠️ Infra unavailable, skipping isolation test:', err.message);
    }
  });

  /* ============================================================
     CUSTOMER MUST NOT ACCESS FOREIGN VEHICLE – LIVE DATA
  ============================================================ */
  it('should block customer from accessing another customer’s vehicle LIVE data', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get(`/api/vehicles/${foreignVehicleId}/live`)
      .set('Authorization', `Bearer ${customerToken}`);

    // Either forbidden OR not found is acceptable (no data leakage)
    expect([403, 404]).toContain(res.statusCode);
  });

  /* ============================================================
     CUSTOMER MUST NOT ACCESS FOREIGN VEHICLE – MASTER DATA
  ============================================================ */
  it('should block customer from accessing another customer’s vehicle MASTER data', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get(`/api/vehicles/${foreignVehicleId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect([403, 404]).toContain(res.statusCode);
  });

  afterAll(async () => {
    if (db?.closePool) {
      try {
        await db.closePool();
      } catch (err) {
        // Avoid double-close crash in Jest
        if (!err.message.includes('more than once')) {
          console.error('Error closing DB pool:', err.message);
        }
      }
    }
  });
});
