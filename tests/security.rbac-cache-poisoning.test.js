const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

describe('Security – RBAC Cache Poisoning', () => {
  let adminToken;
  let customerToken;

  beforeAll(async () => {
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.token).toBeDefined();
    adminToken = adminRes.body.token;

    const customerRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    expect(customerRes.statusCode).toBe(200);
    expect(customerRes.body.token).toBeDefined();
    customerToken = customerRes.body.token;
  });

  it('should not leak admin permissions to customer via RBAC cache', async () => {
    const adminRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(adminRes.statusCode).toBe(200);

    const customerRes = await request(app)
      .get('/api/vehicle-types')
      .set('Authorization', `Bearer ${customerToken}`);

    expect([401, 403]).toContain(customerRes.statusCode);
  });

  afterAll(async () => {
    if (db.closePool) await db.closePool();
  });
});