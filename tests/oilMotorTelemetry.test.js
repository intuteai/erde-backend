// tests/oilMotorTelemetry.test.js
// Oil motor (MCU2) telemetry: oil_motor_speed_rpm / oil_motor_temp_c
// Fully mocked — never touches Postgres or Redis.

jest.mock('../config/postgres', () => ({
  getClient: jest.fn(),
  query: jest.fn(() => Promise.resolve({ rows: [] })),
}));
jest.mock('../config/redis', () => ({ set: jest.fn(() => Promise.resolve()) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../config/postgres');
const {
  insertTelemetryItems,
  LIVE_VALUES_COLUMNS,
  _helpers: { toInt, toBoundedNum },
} = require('../services/telemetryService');
const { formatLiveData } = require('../utils/formatLiveData');

const SPEED_IDX = LIVE_VALUES_COLUMNS.indexOf('oil_motor_speed_rpm');
const TEMP_IDX  = LIVE_VALUES_COLUMNS.indexOf('oil_motor_temp_c');

let client;
beforeEach(() => {
  client = { query: jest.fn(() => Promise.resolve({ rows: [] })), release: jest.fn() };
  db.getClient.mockResolvedValue(client);
});

const insertCalls = () =>
  client.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO live_values'));

const ingest = async (live) => {
  const res = await insertTelemetryItems([
    { ts: Date.now(), vehicleIdOrMasterId: 5, deviceId: 'VCL004', live },
  ]);
  const calls = insertCalls();
  return { res, calls, params: calls[0]?.[1] };
};

describe('column registry ↔ INSERT SQL', () => {
  it('registers both oil motor columns before the trailing jsonb columns', () => {
    expect(SPEED_IDX).toBeGreaterThan(-1);
    expect(TEMP_IDX).toBe(SPEED_IDX + 1);
    expect(LIVE_VALUES_COLUMNS.slice(-2)).toEqual(['cell_modules', 'temp_modules']);
  });

  it('INSERT column list, placeholders and values all line up 1:1 with the registry', async () => {
    const { calls, params } = await ingest({ oil_motor_speed_rpm: 1480, oil_motor_temp_c: 47 });
    const sql = calls[0][0];
    const [, colBlock, valBlock] = sql.match(/INSERT INTO live_values \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*$/m)
      || sql.match(/INSERT INTO live_values \(([\s\S]*?)\)\s*VALUES \(([\s\S]*)\)/);
    const cols = colBlock.split(/[\s,]+/).filter(Boolean);
    const placeholders = valBlock.match(/\$\d+/g);

    expect(cols).toEqual(LIVE_VALUES_COLUMNS);
    expect(placeholders).toHaveLength(LIVE_VALUES_COLUMNS.length);
    expect(placeholders).toEqual(LIVE_VALUES_COLUMNS.map((_, i) => `$${i + 1}`));
    expect(params).toHaveLength(LIVE_VALUES_COLUMNS.length);
    // jsonb casts stay on the last two placeholders only
    expect(valBlock).toMatch(new RegExp(`\\$${cols.length - 1}::jsonb,\\s*\\$${cols.length}::jsonb`));
  });
});

describe('ingest of oil motor fields', () => {
  it('stores the contract example values (1480 RPM, 47 °C)', async () => {
    const { res, params } = await ingest({ oil_motor_speed_rpm: 1480, oil_motor_temp_c: 47 });
    expect(res.inserted).toBe(1);
    expect(params[SPEED_IDX]).toBe(1480);
    expect(params[TEMP_IDX]).toBe(47);
  });

  it('stores NULL when the HMI sends null (stale frame)', async () => {
    const { res, params } = await ingest({ oil_motor_speed_rpm: null, oil_motor_temp_c: null });
    expect(res.inserted).toBe(1);
    expect(params[SPEED_IDX]).toBeNull();
    expect(params[TEMP_IDX]).toBeNull();
  });

  it('stores NULL when fields are absent (older HMI builds) and still inserts the row', async () => {
    const { res, params } = await ingest({ soc_percent: 80 });
    expect(res.inserted).toBe(1);
    expect(params[SPEED_IDX]).toBeNull();
    expect(params[TEMP_IDX]).toBeNull();
  });

  it('handles each field independently', async () => {
    const { params } = await ingest({ oil_motor_speed_rpm: 900, oil_motor_temp_c: null });
    expect(params[SPEED_IDX]).toBe(900);
    expect(params[TEMP_IDX]).toBeNull();
  });

  it('accepts the full decode range: speed raw-15000 (−15000…50535), temp raw-40 (−40…215)', async () => {
    let { params } = await ingest({ oil_motor_speed_rpm: -15000, oil_motor_temp_c: -40 });
    expect(params[SPEED_IDX]).toBe(-15000);
    expect(params[TEMP_IDX]).toBe(-40);
    client.query.mockClear();
    ({ params } = await ingest({ oil_motor_speed_rpm: 50535, oil_motor_temp_c: 215 }));
    expect(params[SPEED_IDX]).toBe(50535);
    expect(params[TEMP_IDX]).toBe(215);
  });

  it('coerces numeric strings', async () => {
    const { params } = await ingest({ oil_motor_speed_rpm: '1480', oil_motor_temp_c: '47.5' });
    expect(params[SPEED_IDX]).toBe(1480);
    expect(params[TEMP_IDX]).toBe(47.5);
  });

  it('rounds fractional RPM instead of letting Postgres reject the whole row', async () => {
    const { params } = await ingest({ oil_motor_speed_rpm: 1480.6 });
    expect(params[SPEED_IDX]).toBe(1481);
  });

  it('nulls values that would overflow their column instead of dropping the row', async () => {
    const { res, params } = await ingest({ oil_motor_speed_rpm: 1e12, oil_motor_temp_c: 1000, soc_percent: 77 });
    expect(res.inserted).toBe(1);
    expect(params[SPEED_IDX]).toBeNull();
    expect(params[TEMP_IDX]).toBeNull();
    expect(params[LIVE_VALUES_COLUMNS.indexOf('soc_percent')]).toBe(77);
  });

  it('nulls garbage (NaN, Infinity, non-numeric strings, objects)', async () => {
    for (const bad of [NaN, Infinity, -Infinity, 'abc', {}, [1, 2]]) {
      client.query.mockClear();
      const { params } = await ingest({ oil_motor_speed_rpm: bad, oil_motor_temp_c: bad });
      expect(params[SPEED_IDX]).toBeNull();
      expect(params[TEMP_IDX]).toBeNull();
    }
  });

  it('does not disturb neighbouring columns', async () => {
    const { params } = await ingest({
      hydraulic_oil_temp_c: 52.1,
      oil_motor_speed_rpm: 1480,
      oil_motor_temp_c: 47,
      cell_modules: [[3.3, 3.31]],
      temp_modules: [[25]],
    });
    expect(params[LIVE_VALUES_COLUMNS.indexOf('hydraulic_oil_temp_c')]).toBe(52.1);
    expect(params[LIVE_VALUES_COLUMNS.indexOf('cell_modules')]).toBe(JSON.stringify([[3.3, 3.31]]));
    expect(params[LIVE_VALUES_COLUMNS.indexOf('temp_modules')]).toBe(JSON.stringify([[25]]));
  });

  it('handles a mixed batch of new and old HMI payloads', async () => {
    const now = Date.now();
    const res = await insertTelemetryItems([
      { ts: now,     vehicleIdOrMasterId: 5, live: { oil_motor_speed_rpm: 1480, oil_motor_temp_c: 47 } },
      { ts: now + 1, vehicleIdOrMasterId: 6, live: { soc_percent: 50 } },
      { ts: now + 2, vehicleIdOrMasterId: 7, live: { oil_motor_speed_rpm: null, oil_motor_temp_c: 48 } },
    ]);
    expect(res.inserted).toBe(3);
    const rows = insertCalls().map(([, p]) => [p[SPEED_IDX], p[TEMP_IDX]]);
    expect(rows).toEqual([[1480, 47], [null, null], [null, 48]]);
  });
});

describe('helpers', () => {
  it('toInt', () => {
    expect(toInt(0)).toBe(0);
    expect(toInt(-0.4)).toBe(-0);
    expect(toInt(2147483647)).toBe(2147483647);
    expect(toInt(2147483648)).toBeNull();
    expect(toInt(undefined)).toBeNull();
  });
  it('toBoundedNum for numeric(5,2)', () => {
    expect(toBoundedNum(999.99, 999.995)).toBe(999.99);
    expect(toBoundedNum(999.995, 999.995)).toBeNull();
    expect(toBoundedNum(-999.99, 999.995)).toBe(-999.99);
    expect(toBoundedNum(null, 999.995)).toBeNull();
  });
});

describe('formatLiveData (live API / SSE payload)', () => {
  it('exposes both oil motor fields as numbers (pg returns numeric as string)', () => {
    const out = formatLiveData({ recorded_at: new Date(), oil_motor_speed_rpm: 1480, oil_motor_temp_c: '47.00' });
    expect(out.oil_motor_speed_rpm).toBe(1480);
    expect(out.oil_motor_temp_c).toBe(47);
  });

  it('keeps nulls / missing columns as null', () => {
    const out = formatLiveData({ recorded_at: new Date(), oil_motor_speed_rpm: null });
    expect(out.oil_motor_speed_rpm).toBeNull();
    expect(out.oil_motor_temp_c).toBeNull();
  });
});
