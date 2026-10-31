// tests/vehicleUsageRoutes.test.js
// Both usage endpoints over HTTP, for a machine launched during the selected range.
// Fully mocked — never touches Postgres.

jest.mock('../config/postgres', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/auth', () => (req, _res, next) => {
  req.user = { user_id: 1, role: 'admin', email: 'admin@test' };
  next();
});
jest.mock('../middleware/checkPermission', () => () => (_req, _res, next) => next());
jest.mock('../middleware/rateLimiter', () => ({
  generalLimiter: (_req, _res, next) => next(),
  liveRateLimiter: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../config/postgres');

// routes/vehicle.js starts a cache-cleanup timer on load.
const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => ({ unref() {} }));
const vehicleRoutes = require('../routes/vehicle');
setIntervalSpy.mockRestore();

const app = express();
app.use('/api/vehicles', vehicleRoutes);

const NEW_MACHINE_ROW = {
  vehicle_master_id: 8,
  baseline_hrs: null, baseline_kwh: null,
  first_hrs: { seconds: 0 }, first_kwh: '0.000',
  last_hrs: { hours: 13, minutes: 52, seconds: 48 }, last_kwh: '365.600',
};
const NEW_MACHINE_USAGE = { vehicle_master_id: 8, running_hours: 13.88, kwh_consumed: 365.6, avg_kwh: 26.34 };

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (sql.includes('unnest')) return { rows: [NEW_MACHINE_ROW] };
    if (sql.includes('EXISTS')) return { rows: [{ exists: true, allowed: true }] };
    return { rows: [{ vehicle_master_id: 8 }] };
  });
});

describe('GET /api/vehicles/analytics/batch', () => {
  it('reports kWh and average for a machine launched during the range', async () => {
    const res = await request(app).get('/api/vehicles/analytics/batch?from=2026-10-01&to=2026-10-31');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 8: NEW_MACHINE_USAGE });
  });

  it('returns 500 when the database fails', async () => {
    db.query.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).get('/api/vehicles/analytics/batch?mode=today');

    expect(res.status).toBe(500);
  });
});

describe('GET /api/vehicles/:id/analytics', () => {
  it('reports kWh and average for a machine launched during the range', async () => {
    const res = await request(app).get('/api/vehicles/8/analytics?from=2026-10-01&to=2026-10-31');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...NEW_MACHINE_USAGE,
      mode: 'custom',
      from: '2026-09-30T18:30:00.000Z',
      to: '2026-10-31T18:29:59.999Z',
    });
  });
});
