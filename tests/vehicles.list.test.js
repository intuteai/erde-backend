const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');

let adminToken;
let customerToken;

describe('Vehicles List API', () => {
  beforeAll(async () => {
    // Fresh login — critical!
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;
    expect(adminToken).toBeDefined();

    const customerRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    expect(customerRes.statusCode).toBe(200);
    customerToken = customerRes.body.token;
    expect(customerToken).toBeDefined();
  });

  it('should block unauthenticated access', async () => {
    const res = await request(app).get('/api/vehicles');
    expect(res.statusCode).toBe(401);
  });

  it('should allow customer with read permission', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should allow admin and return vehicle list', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  afterAll(async () => {
    if (db.closePool) await db.closePool();
  });
});