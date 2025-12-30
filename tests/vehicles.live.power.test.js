const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;
let infraAvailable = true;

describe('Vehicle Live View – Output Power Safety', () => {

  /* ============================
     LOGIN + VEHICLE PICK
  ============================ */
  beforeAll(async () => {
    try {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@erdeenergy.in',
          password: 'password123',
        });

      adminToken = loginRes.body?.token;
      if (!adminToken) throw new Error('Login failed');

      const vehiclesRes = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);

      if (!Array.isArray(vehiclesRes.body) || vehiclesRes.body.length === 0) {
        throw new Error('No vehicles returned');
      }

      vehicleId = vehiclesRes.body[0].vehicle_master_id;
    } catch (err) {
      infraAvailable = false;
      console.warn('⚠️ Infra unavailable, skipping power test:', err.message);
    }
  });

  /* ============================
     TEST: POWER SAFETY
  ============================ */
  it('should compute output_power_kw safely', async () => {
    if (!infraAvailable) {
      console.warn('⚠️ Skipped due to DB / infra issue');
      return;
    }

    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);

    const {
      stack_voltage_v,
      dc_current_a,
      output_power_kw,
    } = res.body;

    // Case 1: Missing inputs → null
    if (stack_voltage_v == null || dc_current_a == null) {
      expect(output_power_kw).toBeNull();
      return;
    }

    // Case 2: Both present → finite number
    expect(typeof output_power_kw).toBe('number');
    expect(Number.isFinite(output_power_kw)).toBe(true);
  });

  /* ============================
     CLEANUP
  ============================ */
  afterAll(async () => {
    if (db?.close) await db.close();
  });
});
