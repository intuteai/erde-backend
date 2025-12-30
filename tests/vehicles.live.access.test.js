const request = require('supertest');
const app = require('../app');

let adminToken;
let customerToken;
let vehicleId;

describe('Vehicle Live View – Access & RBAC', () => {

  beforeAll(async () => {
    // Admin
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    adminToken = adminRes.body.token;
    expect(adminToken).toBeDefined();

    // Customer
    const customerRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'customer@intuteai.in',
        password: 'password123',
      });

    customerToken = customerRes.body.token;
    expect(customerToken).toBeDefined();

    // Fetch any vehicle ID (safe, read-only)
    const vehiclesRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    if (vehiclesRes.body.length > 0) {
      vehicleId = vehiclesRes.body[0].vehicle_master_id;
    }
  });

  it('should block unauthenticated access', async () => {
    const res = await request(app).get('/api/vehicles/1/live');
    expect(res.statusCode).toBe(401);
  });

  it('should allow admin access', async () => {
    if (!vehicleId) return;

    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('should allow customer access if permitted', async () => {
    if (!vehicleId) return;

    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('should return empty object for non-existent vehicle', async () => {
    const res = await request(app)
      .get('/api/vehicles/99999999/live')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });

});
