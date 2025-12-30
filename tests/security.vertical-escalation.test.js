const request = require('supertest');
const app = require('../app');

describe('Security – Vertical Privilege Escalation', () => {
  let customerToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    customerToken = res.body.token;
  });

  it('should block customer from admin-only modules even with valid JWT', async () => {
    const adminOnlyRoutes = [
      '/api/vehicle-types',
      '/api/customers',
      '/api/database-logs',
      '/api/config',
    ];

    for (const route of adminOnlyRoutes) {
      const res = await request(app)
        .get(route)
        .set('Authorization', `Bearer ${customerToken}`);

      // 404 is allowed (route hidden), 403 is allowed (RBAC)
      expect([401, 403, 404]).toContain(res.statusCode);
    }
  });
});
