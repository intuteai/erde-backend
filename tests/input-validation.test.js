const request = require('supertest');
const app = require('../app');

describe('Input Validation – Vehicle Types', () => {
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

  /**
   * 1️⃣ Missing required field
   */
  it('should REJECT missing required fields', async () => {
    const res = await request(app)
      .post('/api/vehicle-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({}); // missing everything

    expect(res.statusCode).toBe(400);
  });

  /**
   * 2️⃣ Empty string field
   */
  it('should REJECT empty name field', async () => {
    const res = await request(app)
      .post('/api/vehicle-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: '',
      });

    expect(res.statusCode).toBe(400);
  });

  /**
   * 3️⃣ Wrong data type
   */
  it('should REJECT invalid data types', async () => {
    const res = await request(app)
      .post('/api/vehicle-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 12345, // should be string
      });

    expect(res.statusCode).toBe(400);
  });

  /**
   * 4️⃣ Unexpected extra fields
   * Backend should ignore or reject, but NOT crash
   */
  it('should HANDLE unexpected fields safely', async () => {
    const res = await request(app)
      .post('/api/vehicle-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'TestType',
        hackedField: 'DROP TABLE users;',
      });

    expect([200, 400]).toContain(res.statusCode);
  });

  /**
   * 5️⃣ SQL-like payload (sanity check)
   */
  it('should REJECT SQL-like payloads', async () => {
    const res = await request(app)
      .post('/api/vehicle-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: "'; DROP TABLE vehicle_type_master; --",
      });

    expect(res.statusCode).toBe(400);
  });
});
