const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let vehicleId;

describe('Vehicle Live View – Cache Expiry', () => {
  let querySpy;

  beforeAll(async () => {
    querySpy = jest.spyOn(db, 'query');

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    adminToken = loginRes.body.token;

    const vehiclesRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(vehiclesRes.statusCode).toBe(200, 'Admin access to /api/vehicles failed');
    expect(Array.isArray(vehiclesRes.body)).toBe(true);
    expect(vehiclesRes.body.length).toBeGreaterThan(0);

    vehicleId = vehiclesRes.body[0].vehicle_master_id;
    expect(vehicleId).toBeDefined();
  });

  it('should refresh live data after cache TTL expires', async () => {
    // Clear any previous calls
    querySpy.mockClear();

    // 1. First request → DB hit + cache set
    const first = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(first.statusCode).toBe(200);

    // 2. Second request (immediately) → cache hit
    const second = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(second.statusCode).toBe(200);

    // 3. Wait longer than TTL (your cache is ~1.5s)
    await new Promise(resolve => setTimeout(resolve, 1800));

    // 4. Third request → should hit DB again
    const third = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(third.statusCode).toBe(200);

    const liveQueries = querySpy.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM live_values')
    );

    // We expect at least 2 distinct DB hits: one at start, one after expiry
    expect(liveQueries.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    querySpy.mockRestore();
    if (db.closePool) await db.closePool();
  });
});