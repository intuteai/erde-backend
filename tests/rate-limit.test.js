const request = require('supertest');
const app = require('../app');
const db = require('../config/postgres');
const rateLimiter = require('../middleware/rateLimiter');

describe('Rate Limiting – Security & Stability', () => {
  let adminToken;
  let customerToken;

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({
      email: 'admin@erdeenergy.in',
      password: 'password123',
    });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const customerRes = await request(app).post('/api/auth/login').send({
      email: 'customer@intuteai.in',
      password: 'password123',
    });
    expect(customerRes.statusCode).toBe(200);
    customerToken = customerRes.body.token;
  });

  beforeEach(() => {
    rateLimiter._resetAllBuckets();
  });

  it('should allow requests under rate limit', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
    }
  });

  it('should block requests over rate limit with 429', async () => {
    // First 20 requests should pass
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
    }

    // The 21st request should be blocked with 429
    const blockedRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(blockedRes.statusCode).toBe(429);
  });

  it('should reset rate limit after time window', async () => {
    // Exhaust the limit
    for (let i = 0; i < 21; i++) {
      await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);
    }

    // Simulate window reset
    rateLimiter._resetAllBuckets();

    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
  });

  it('should apply rate limits per user (not globally)', async () => {
    // Exhaust admin's limit
    for (let i = 0; i < 21; i++) {
      await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);
    }

    // Customer should still have full quota
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toBe(200);
  });

  it('should return proper headers when rate limited', async () => {
    let blockedRes;

    // First 20 should pass
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .get('/api/vehicles')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
    }

    // 21st gets 429
    blockedRes = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.headers['retry-after']).toBeDefined();
    expect(blockedRes.body.error).toBe('Too many requests');
    expect(blockedRes.body.retry_after).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await db.closePool();
  });
});