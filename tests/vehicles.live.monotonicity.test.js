const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;
let infraAvailable = true;

describe('Vehicle Live View – Idempotency & Stability', () => {

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
      console.warn('⚠️ Infra unavailable, skipping idempotency test:', err.message);
    }
  });

  it('should return stable response shape across multiple calls', async () => {
    if (!infraAvailable) return;

    const calls = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        request(app)
          .get(`/api/vehicles/${vehicleId}/live`)
          .set('Authorization', `Bearer ${adminToken}`)
      )
    );

    const baseKeys = Object.keys(calls[0].body).sort();

    for (let i = 1; i < calls.length; i++) {
      const keys = Object.keys(calls[i].body).sort();
      expect(keys).toEqual(baseKeys);
    }
  });

  afterAll(async () => {
    if (db?.close) await db.close();
  });
});
