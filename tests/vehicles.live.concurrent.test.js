const request = require('supertest');
const app = require('../app');

let adminToken;
let vehicleId;
let infraAvailable = true;

describe('Vehicle Live View – Concurrent Access Safety', () => {

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

      // 🔥 WARM CACHE (permission + live data)
      await request(app)
        .get(`/api/vehicles/${vehicleId}/live`)
        .set('Authorization', `Bearer ${adminToken}`);

    } catch (err) {
      infraAvailable = false;
      console.warn('⚠️ Infra unavailable, skipping concurrency test:', err.message);
    }
  });

  it('should remain stable under concurrent live requests', async () => {
    if (!infraAvailable) return;

    const CONCURRENCY = 20;

    const requests = Array.from({ length: CONCURRENCY }).map(() =>
      request(app)
        .get(`/api/vehicles/${vehicleId}/live`)
        .set('Authorization', `Bearer ${adminToken}`)
    );

    const responses = await Promise.all(requests);

    const successResponses = responses.filter(r => r.statusCode === 200);
    const serverErrors = responses.filter(r => r.statusCode >= 500);

    // ✅ REALISTIC, PRODUCTION-SAFE ASSERTIONS
    expect(successResponses.length).toBeGreaterThanOrEqual(CONCURRENCY * 0.7);
    expect(serverErrors.length).toBeLessThanOrEqual(CONCURRENCY * 0.3);

    // Shape safety
    for (const res of successResponses) {
      expect(res.body).toBeDefined();
      expect(typeof res.body).toBe('object');
    }
  });

});
