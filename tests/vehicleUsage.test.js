// tests/vehicleUsage.test.js
// Usage in a date range, from the cumulative hours and kWh counters.
// Fully mocked — never touches Postgres.

jest.mock('../config/postgres', () => ({ query: jest.fn() }));

const db = require('../config/postgres');
const { computeUsage, fetchVehicleUsage } = require('../services/vehicleUsage');

const hrs = (hours, minutes = 0) => ({ hours, minutes });
const reading = (total_running_hrs, total_kwh_consumed) => ({ total_running_hrs, total_kwh_consumed });

const EMPTY = { running_hours: 0, kwh_consumed: 0, avg_kwh: null };

describe('computeUsage', () => {
  it('uses the last reading before the range as the start when there is one', () => {
    expect(computeUsage({
      baseline: reading(hrs(100), '1000.000'),
      firstInRange: reading(hrs(101), '1030.000'),
      last: reading(hrs(110), '1250.000'),
    })).toEqual({ running_hours: 10, kwh_consumed: 250, avg_kwh: 25 });
  });

  it('reports kWh for a new machine with no reading before the range (EE-R-DC-CETL90-L4)', () => {
    expect(computeUsage({
      baseline: null,
      firstInRange: reading(null, '0.000'),
      last: reading({ hours: 13, minutes: 52, seconds: 48 }, '365.600'),
    })).toEqual({ running_hours: 13.88, kwh_consumed: 365.6, avg_kwh: 26.34 });
  });

  it('does not count what was already on the counters at launch', () => {
    expect(computeUsage({
      baseline: null,
      firstInRange: reading(hrs(60), '1600.000'),
      last: reading(hrs(62), '1650.000'),
    })).toEqual({ running_hours: 2, kwh_consumed: 50, avg_kwh: 25 });
  });

  it('reads counters of more than a day', () => {
    expect(computeUsage({
      baseline: reading({ days: 1 }, '0'),
      firstInRange: null,
      last: reading({ days: 2, hours: 6 }, '300'),
    }).running_hours).toBe(30);
  });

  it('never reports negative usage when a counter goes backwards', () => {
    expect(computeUsage({
      baseline: reading(hrs(5), '228.080'),
      firstInRange: null,
      last: reading(hrs(7), '28.160'),
    })).toEqual({ running_hours: 2, kwh_consumed: 0, avg_kwh: 0 });
  });

  it('has no average when the machine did not run', () => {
    expect(computeUsage({
      baseline: reading(hrs(5), '100'),
      firstInRange: null,
      last: reading(hrs(5), '100'),
    })).toEqual(EMPTY);
  });

  it('is empty when there are no readings in the range', () => {
    expect(computeUsage({ baseline: reading(hrs(5), '100'), firstInRange: null, last: null })).toEqual(EMPTY);
    expect(computeUsage({ baseline: null, firstInRange: null, last: null })).toEqual(EMPTY);
  });
});

describe('fetchVehicleUsage', () => {
  const start = new Date('2026-10-01T00:00:00+05:30');
  const end = new Date('2026-10-31T23:59:59.999+05:30');

  beforeEach(() => db.query.mockReset());

  it('returns usage for each vehicle, falling back to the first reading in the range', async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          vehicle_master_id: 8,
          baseline_hrs: null, baseline_kwh: null,
          first_hrs: null, first_kwh: '0.000',
          last_hrs: hrs(10), last_kwh: '200.000',
        },
        {
          vehicle_master_id: 1,
          baseline_hrs: hrs(100), baseline_kwh: '1000.000',
          first_hrs: null, first_kwh: null,
          last_hrs: hrs(110), last_kwh: '1250.000',
        },
      ],
    });

    await expect(fetchVehicleUsage([1, 8], start, end)).resolves.toEqual({
      1: { vehicle_master_id: 1, running_hours: 10, kwh_consumed: 250, avg_kwh: 25 },
      8: { vehicle_master_id: 8, running_hours: 10, kwh_consumed: 200, avg_kwh: 20 },
    });
    expect(db.query.mock.calls[0][1]).toEqual([[1, 8], start, end]);
  });

  it('returns empty usage for a vehicle the query did not return', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(fetchVehicleUsage([3], start, end)).resolves.toEqual({
      3: { vehicle_master_id: 3, ...EMPTY },
    });
  });

  it('propagates database errors to the route', async () => {
    db.query.mockRejectedValue(new Error('connection lost'));

    await expect(fetchVehicleUsage([1], start, end)).rejects.toThrow('connection lost');
  });
});
