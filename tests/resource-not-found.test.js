const request = require('supertest');
const app = require('../app');

describe('Resource Safety – 404 Not Found', () => {
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

  it('should return 404 for non-existent vehicle type (GET)', async () => {
    const res = await request(app)
      .get('/api/vehicle-types/999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 for non-existent vehicle type (PUT)', async () => {
    const res = await request(app)
      .put('/api/vehicle-types/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'DoesNotExist' });

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 for non-existent vehicle type (DELETE)', async () => {
    const res = await request(app)
      .delete('/api/vehicle-types/999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(404);
  });
});
