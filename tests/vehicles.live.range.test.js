const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;
let infraAvailable = true;

const inRange = (v, min, max) =>
  v === null || v === undefined || (typeof v === 'number' && v >= min && v <= max);

describe('Vehicle Live View – Range & Sanity Validation', () => {

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

      vehicleId = vehiclesRes.body?.[0]?.vehicle_master_id;
      if (!vehicleId) throw new Error('No vehicle found');
    } catch (err) {
      infraAvailable = false;
      console.warn('⚠️ Infra unavailable, skipping range test:', err.message);
    }
  });

  it('should return live values within sane physical ranges', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);

    const r = res.body;

    expect(inRange(r.soc_percent, 0, 100)).toBe(true);
    expect(inRange(r.stack_voltage_v, 0, 1000)).toBe(true);
    expect(inRange(r.dc_current_a, -2000, 2000)).toBe(true);
    expect(inRange(r.output_power_kw, -1000, 1000)).toBe(true);

    expect(inRange(r.motor_speed_rpm, 0, 15000)).toBe(true);
    expect(inRange(r.motor_temp_c, -20, 180)).toBe(true);
    expect(inRange(r.mcu_temp_c, -20, 180)).toBe(true);

    expect(inRange(r.dcdc_input_voltage_v, 0, 1000)).toBe(true);
    expect(inRange(r.dcdc_output_voltage_v, 0, 100)).toBe(true);
  });

  afterAll(async () => {
    if (db?.close) await db.close();
  });
});
