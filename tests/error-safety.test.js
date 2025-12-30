const request = require('supertest');
const app = require('../app');

describe('Error Safety – No Internal Leaks', () => {
  let adminToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(res.statusCode).toBe(200);
    adminToken = res.body.token;
  });

  it('should not leak stack trace or SQL errors', async () => {
    const res = await request(app)
      .get('/api/vehicle-types/abc') // invalid id type
      .set('Authorization', `Bearer ${adminToken}`);

    expect([400, 404]).toContain(res.statusCode);

    // ❌ Must NOT expose internals
    if (res.body && typeof res.body === 'object') {
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toMatch(/error:/i);
      expect(bodyText).not.toMatch(/stack/i);
      expect(bodyText).not.toMatch(/select|insert|delete|update/i);
    }
  });
});
