const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;

describe('Vehicle Live View – Cache Effectiveness', () => {
  let querySpy;

  beforeAll(async () => {
    // Spy on DB queries
    querySpy = jest.spyOn(db, 'query');

    // Fresh login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    adminToken = loginRes.body.token;

    // Get vehicle list — must succeed
    const vehiclesRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(vehiclesRes.statusCode).toBe(200, 'Admin should have access to /api/vehicles');
    expect(Array.isArray(vehiclesRes.body)).toBe(true);
    expect(vehiclesRes.body.length).toBeGreaterThan(0, 'There should be at least one vehicle in DB');

    vehicleId = vehiclesRes.body[0].vehicle_master_id;
    expect(vehicleId).toBeDefined();
  });

  it('should reuse cached live data within TTL', async () => {
    const CONCURRENCY = 15;

    const requests = Array.from({ length: CONCURRENCY }, () =>
      request(app)
        .get(`/api/vehicles/${vehicleId}/live`)
        .set('Authorization', `Bearer ${adminToken}`)
    );

    const responses = await Promise.all(requests);

    // All should be 200
    responses.forEach(res => {
      expect(res.statusCode).toBe(200);
    });

    // Count actual DB queries to live_values table
    const liveQueries = querySpy.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM live_values')
    );

    // With cache TTL ~1.5s and concurrent requests, expect 1 or 2 DB hits max
    expect(liveQueries.length).toBeLessThanOrEqual(2);
  });

  afterAll(async () => {
    querySpy.mockRestore();
    if (db.closePool) await db.closePool();
  });
});