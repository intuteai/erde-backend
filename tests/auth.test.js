// tests/auth.test.js
const request = require('supertest');
const app = require('../app');

// These tests require a real DB with a known test user.
// Set TEST_EMAIL and TEST_PASSWORD in your .env or environment.
const TEST_EMAIL    = process.env.TEST_EMAIL    || 'admin@erde.in';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpassword';

describe('POST /api/auth/login', () => {
  it('returns 400 when email or password missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 401 for wrong credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('sets HttpOnly cookies and returns user on success', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.token).toBeUndefined(); // token must NOT be in body

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();

    const accessCookie  = cookies.find(c => c.startsWith('access_token='));
    const refreshCookie = cookies.find(c => c.startsWith('refresh_token='));

    expect(accessCookie).toBeDefined();
    expect(accessCookie).toMatch(/HttpOnly/i);
    expect(accessCookie).toMatch(/Secure/i);

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Path=\/api\/auth/i);
  });
});

describe('GET /api/auth/me', () => {
  let accessCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    accessCookie = res.headers['set-cookie'].find(c => c.startsWith('access_token='));
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user when valid access cookie present', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', accessCookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_EMAIL);
  });
});

describe('POST /api/auth/refresh', () => {
  let refreshCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    refreshCookie = res.headers['set-cookie'].find(c => c.startsWith('refresh_token='));
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('issues new access_token cookie from valid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();

    const cookies = res.headers['set-cookie'];
    const newAccessCookie = cookies?.find(c => c.startsWith('access_token='));
    expect(newAccessCookie).toBeDefined();
    expect(newAccessCookie).toMatch(/HttpOnly/i);
  });
});

describe('POST /api/auth/logout', () => {
  let refreshCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    refreshCookie = res.headers['set-cookie'].find(c => c.startsWith('refresh_token='));
  });

  it('clears cookies and returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] || [];
    const accessCleared  = cookies.find(c => c.startsWith('access_token=;') || c.includes('access_token=;'));
    const refreshCleared = cookies.find(c => c.startsWith('refresh_token=;') || c.includes('refresh_token=;'));
    expect(accessCleared  || cookies.some(c => c.includes('access_token') && c.includes('Max-Age=0'))).toBeTruthy();
    expect(refreshCleared || cookies.some(c => c.includes('refresh_token') && c.includes('Max-Age=0'))).toBeTruthy();
  });

  it('refresh fails after logout (token deleted from DB)', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(res.status).toBe(401);
  });
});
