const request = require('supertest');
const app = require('../app');

let adminToken;
let vehicleId;

describe('Vehicle Live View – Response Shape Safety', () => {
  beforeAll(async () => {
    // Fresh login every time
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    adminToken = loginRes.body.token;

    // Get vehicle list to extract an ID
    const vehiclesRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(vehiclesRes.statusCode).toBe(200);
    expect(Array.isArray(vehiclesRes.body)).toBe(true);
    expect(vehiclesRes.body.length).toBeGreaterThan(0);

    vehicleId = vehiclesRes.body[0].vehicle_master_id;
    expect(vehicleId).toBeDefined();
  });

  it('should return a stable response with no undefined values', async () => {
    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}/live`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');

    const allowedStringFields = [
      'motor_operation_mode',
      'motor_rotation_dir',
      'battery_status',
    ];

    Object.entries(res.body).forEach(([key, value]) => {
      expect(value).not.toBeUndefined();

      if (allowedStringFields.includes(key)) {
        expect(typeof value === 'string' || value === null).toBe(true);
        return;
      }

      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null ||
        typeof value === 'object'
      ) {
        return;
      }

      throw new Error(`Invalid type for ${key}: ${typeof value}`);
    });
  });
});