const request = require('supertest');
const app = require('../app');

describe('Health API', () => {
  it('should return OK', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
  });
});
