const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

describe('Security – Horizontal Privilege Escalation (ID Tampering)', () => {
  let customerToken;
  let ownVehicleId;
  let foreignVehicleId;

  beforeAll(async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    customerToken = login.body.token;

    const own = await db.query(`
      SELECT vm.vehicle_master_id
      FROM vehicle_master vm
      JOIN customer_master cm ON vm.customer_id = cm.customer_id
      WHERE cm.user_id = (
        SELECT user_id FROM users WHERE email = 'customer@intuteai.in'
      )
      LIMIT 1
    `);

    const foreign = await db.query(`
      SELECT vm.vehicle_master_id
      FROM vehicle_master vm
      JOIN customer_master cm ON vm.customer_id = cm.customer_id
      WHERE cm.user_id != (
        SELECT user_id FROM users WHERE email = 'customer@intuteai.in'
      )
      LIMIT 1
    `);

    if (!own.rows.length || !foreign.rows.length) {
      console.warn('⚠️ Skipping horizontal escalation tests (insufficient data)');
      return;
    }

    ownVehicleId = own.rows[0].vehicle_master_id;
    foreignVehicleId = foreign.rows[0].vehicle_master_id;
  });

  it('should allow customer to access their own vehicle', async () => {
    if (!ownVehicleId) return;

    const res = await request(app)
      .get(`/api/vehicles/${ownVehicleId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
  });

  it('should block customer from accessing another customer’s vehicle', async () => {
    if (!foreignVehicleId) return;

    const res = await request(app)
      .get(`/api/vehicles/${foreignVehicleId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect([403, 404]).toContain(res.statusCode);
  });

  it('should return empty object for live view of foreign vehicle', async () => {
    if (!foreignVehicleId) return;

    const res = await request(app)
      .get(`/api/vehicles/${foreignVehicleId}/live`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });

  afterAll(async () => {
    await db.closePool();
  });
});
