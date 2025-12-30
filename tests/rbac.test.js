const request = require('supertest');
const app = require('../app');

describe('RBAC – Permission Enforcement', () => {
  let adminToken;
  let customerToken;

  beforeAll(async () => {
    // 🔐 Login as ADMIN
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    // 👤 Login as CUSTOMER (non-admin)
    const customerRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    expect(customerRes.statusCode).toBe(200);
    customerToken = customerRes.body.token;
  });

  /**
   * ❌ NON-ADMIN must NOT access admin-only route
   * Using fake ID so nothing is deleted
   */
  it('should BLOCK customer from deleting vehicle types', async () => {
    const res = await request(app)
      .delete('/api/vehicle-types/999999') // fake ID → safe
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(403);
  });

  /**
   * ✅ ADMIN is allowed (route-level permission works)
   * 404 is acceptable because ID does not exist
   */
  it('should ALLOW admin to access delete route', async () => {
    const res = await request(app)
      .delete('/api/vehicle-types/999999') // fake ID → safe
      .set('Authorization', `Bearer ${adminToken}`);

    expect([200, 204, 404]).toContain(res.statusCode);
  });
});

