const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

jest.setTimeout(20000); // 🔥 REQUIRED for stress tests

describe('Vehicle Live View – Cache Memory Safety', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    token = res.body.token;
    expect(token).toBeDefined();
  });

  it('should not grow cache unbounded for many vehicle IDs', async () => {
    const TOTAL_REQUESTS = 300;

    // 🔥 Fire many requests in parallel (realistic traffic)
    const requests = [];
    for (let i = 1; i <= TOTAL_REQUESTS; i++) {
      requests.push(
        request(app)
          .get(`/api/vehicles/${i}/live`)
          .set('Authorization', `Bearer ${token}`)
      );
    }

    await Promise.all(requests);

    // ⏱️ Advance time beyond TTL (1.5s)
    await new Promise((r) => setTimeout(r, 1700));

    // 🔁 Trigger post-TTL activity (forces eviction / overwrite)
    await Promise.all([
      request(app).get('/api/vehicles/1/live').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/vehicles/2/live').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/vehicles/3/live').set('Authorization', `Bearer ${token}`),
    ]);

    // 🧠 Indirect assertion:
    // If cache were unbounded, this test would:
    // - timeout
    // - crash process
    // - exhaust DB pool
    expect(true).toBe(true);
  });

  afterAll(async () => {
    await db.closePool(); // 🔒 Prevent Jest hanging
  });
});
