const request = require('supertest');
const app = require('../app');

let adminToken;
let vehicleId;

describe('Vehicle Live View – Response Shape Safety', () => {
  beforeAll(async () => {
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

    expect(vehiclesRes.statusCode).toBe(200);
    expect(Array.isArray(vehiclesRes.body)).toBe(true);
    expect(vehiclesRes.body.length).toBeGreaterThan(0);

    vehicleId = vehiclesRes.body[0].vehicle_master_id;
  });

  it('should return a stable response with no undefined values', async () => {
    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    // ... rest of your shape checks
  });
});