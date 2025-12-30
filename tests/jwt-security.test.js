const request = require('supertest');
const app = require('../app');

describe('JWT Security – Invalid & Tampered Tokens', () => {
  let validToken;

  beforeAll(async () => {
    // Get a VALID token first
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'admin@erdeenergy.in',
        password: 'password123',
      });

    expect(res.statusCode).toBe(200);
    validToken = res.body.token;
  });

  it('should REJECT a completely invalid JWT', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', 'Bearer abc.def.ghi'); // garbage token

    expect(res.statusCode).toBe(401);
  });

  it('should REJECT a tampered JWT', async () => {
    // Modify one character in the token
    const tamperedToken =
      validToken.slice(0, -1) +
      (validToken.slice(-1) === 'a' ? 'b' : 'a');

    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${tamperedToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should REJECT token without Bearer prefix', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', validToken); // missing "Bearer "

    expect(res.statusCode).toBe(401);
  });
});
