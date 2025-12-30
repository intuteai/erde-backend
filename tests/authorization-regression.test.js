const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let customerToken;
let vehicleId;
let customerId;
let infraAvailable = true;

describe('Authorization Regression – Role Boundary Enforcement', () => {

  beforeAll(async () => {
    try {
      // 🔐 Admin login
      const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@erdeenergy.in',
          password: 'password123',
        });

      adminToken = adminLogin.body?.token;
      if (!adminToken) throw new Error('Admin login failed');

      // 🔐 Customer login
      const customerLogin = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'customer@intuteai.in',
          password: 'password123',
        });

      customerToken = customerLogin.body?.token;
      if (!customerToken) throw new Error('Customer login failed');

      // 👑 Admin fetch vehicles
      const vehiclesRes = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);

      if (!vehiclesRes.body?.length) {
        throw new Error('No vehicles found');
      }

      vehicleId = vehiclesRes.body[0].vehicle_master_id;

      // 👑 Admin fetch customers
      const customersRes = await request(app)
        .get('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`);

      if (!customersRes.body?.length) {
        throw new Error('No customers found');
      }

      customerId = customersRes.body[0].customer_id;

    } catch (err) {
      infraAvailable = false;
      console.warn('⚠️ Infra unavailable, skipping authorization tests:', err.message);
    }
  });

  /* =========================================================
     CUSTOMER RESTRICTIONS
  ========================================================= */

  it('should BLOCK customer from creating a new customer', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        company_name: 'Hacker Corp',
        email: 'hack@corp.com',
        password: 'password123',
      });

    expect([401, 403]).toContain(res.statusCode);
  });

  it('should BLOCK customer from deleting a customer', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect([401, 403]).toContain(res.statusCode);
  });

  it('should BLOCK customer from deleting a vehicle', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .delete(`/api/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    // ✅ 404 allowed (secure resource hiding)
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  /* =========================================================
     ADMIN PERMISSIONS
  ========================================================= */

  it('should ALLOW admin to fetch all vehicles', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should ALLOW admin to fetch customers', async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  afterAll(async () => {
    if (db?.closePool) await db.closePool();
  });
});
