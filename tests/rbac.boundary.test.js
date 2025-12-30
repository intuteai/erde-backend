const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

describe('RBAC Boundary – Cross-Module Access Control (Corrected)', () => {
  let adminToken;
  let customerToken;

  beforeAll(async () => {
    // Fresh admin login
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@erdeenergy.in', password: 'password123' });

    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.token).toBeDefined();
    adminToken = adminRes.body.token;

    // Fresh customer login
    const customerRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'customer@intuteai.in', password: 'password123' });

    expect(customerRes.statusCode).toBe(200);
    expect(customerRes.body.token).toBeDefined();
    customerToken = customerRes.body.token;
  });

  /* =========================
     CUSTOMER → ADMIN MODULES
  ========================= */

  it('should block customer from accessing admin-only module (vehicle-types)', async () => {
    const res = await request(app)
      .get('/api/vehicle-types')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(403);
  });

  it('should block customer from deleting vehicle types', async () => {
    const res = await request(app)
      .delete('/api/vehicle-types/1')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(403);
  });

  it('should allow customer to read vehicle list (vehicles:read)', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should allow customer to access battery analytics (analytics:read)', async () => {
    const res = await request(app)
      .get('/api/battery/analytics/1')
      .set('Authorization', `Bearer ${customerToken}`);

    expect([200, 404]).toContain(res.statusCode);
  });

  it('should allow customer to access motor analytics (analytics:read)', async () => {
    const res = await request(app)
      .get('/api/motor/analytics/1')
      .set('Authorization', `Bearer ${customerToken}`);

    expect([200, 404]).toContain(res.statusCode);
  });

  /* =========================
     ADMIN SHOULD PASS
  ========================= */

  it('should allow admin to access all modules', async () => {
    const endpoints = [
      '/api/vehicles',
      '/api/vehicle-types',
      '/api/customers',
      '/api/database-logs',
    ];

    for (const endpoint of endpoints) {
      const res = await request(app)
        .get(endpoint)
        .set('Authorization', `Bearer ${adminToken}`);

      // This is the one that was failing with 403
      expect(res.statusCode).not.toBe(403);
      // Bonus: most should be 200
      if (endpoint !== '/api/database-logs') {
        expect(res.statusCode).toBe(200);
      }
    }
  });

  afterAll(async () => {
    await db.closePool();
  });
});