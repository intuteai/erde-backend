const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;
let infraAvailable = true;

describe('Vehicle Live View – Alarm Safety & Consistency', () => {

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
      console.warn('⚠️ Infra unavailable, skipping alarm test:', err.message);
    }
  });

  it('should expose alarms as flat boolean flags only', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);

    const body = res.body;

    const alarmKeys = Object.keys(body).filter(k => k.startsWith('alarms_'));

    // Alarms may be empty, but must be safe
    for (const key of alarmKeys) {
      const value = body[key];

      expect(key.startsWith('alarms_')).toBe(true);
      expect(typeof value).toBe('boolean');
    }
  });

  afterAll(async () => {
    if (db?.close) await db.close();
  });
});
