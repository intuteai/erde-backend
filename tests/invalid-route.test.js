const request = require('supertest');
const app = require('../app');

describe('Invalid Route Handling', () => {
  it('should return 404 for unknown API route', async () => {
    const res = await request(app).get('/api/this-route-does-not-exist');

    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
