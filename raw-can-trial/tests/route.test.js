// raw-can-trial/tests/route.test.js
// The store is mocked: these tests never touch a database.
jest.mock('../store');

const express = require('express');
const request = require('supertest');
const store = require('../store');
const router = require('../route');

const KEY = 'test-key-0123456789';
const BATCH_ID = '09218c79-2207-465e-8f93-3fd2f8f30c85';

const body = () => ({
  schemaVersion: '1.0',
  vehicleMasterId: 2,
  deviceId: 'VCL001',
  sessionId: '9bbf8dd3-2db0-4e4c-a39f-488c919421d2',
  batchId: BATCH_ID,
  sentAtMs: 1790742600250,
  firstSequence: 8421,
  lastSequence: 8422,
  frames: [8421, 8422].map((sequence) => ({
    sequence,
    receivedAtMs: 1790742600012,
    monotonicMs: 1842022,
    canId: 0x18ffc13a,
    isExtended: true,
    dlc: 8,
    dataBase64: 'AQIDBAUGBwg=',
    direction: 'rx',
    channel: 0,
  })),
});

const app = express();
app.use(express.json());
app.use('/raw', router);

const post = (payload = body(), key = KEY) => {
  const req = request(app).post('/raw/v1');
  if (key !== null) req.set('x-api-key', key);
  return req.send(payload);
};

const ENV_KEYS = ['RAW_CAN_ENABLED', 'RAW_CAN_API_KEY', 'RAW_CAN_ALLOWED_PAIRS'];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.RAW_CAN_ENABLED = 'true';
  process.env.RAW_CAN_API_KEY = KEY;
  process.env.RAW_CAN_ALLOWED_PAIRS = '2:VCL001';
  store.insertBatch.mockReset();
  store.insertBatch.mockResolvedValue({
    duplicate: false,
    overlap: false,
    ackSequence: 8422,
    acceptedFrames: 2,
    serverReceivedAtMs: 1790742600311,
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('POST /v1', () => {
  it('returns 503 when the kill switch is off', async () => {
    process.env.RAW_CAN_ENABLED = 'false';
    const res = await post();
    expect(res.status).toBe(503);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong', 'test-key-9876543210'],
    ['different length', 'short'],
  ])('returns 401 when the key is %s', async (_name, key) => {
    const res = await post(body(), key);
    expect(res.status).toBe(401);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('returns 401 when no key is configured, even if one is sent', async () => {
    process.env.RAW_CAN_API_KEY = '';
    const res = await post(body(), '');
    expect(res.status).toBe(401);
  });

  it('returns 400 with a reason for an invalid batch', async () => {
    const bad = body();
    bad.frames[0].dlc = 9;
    const res = await post(bad);
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);
    expect(res.body.reason).toMatch(/frames\[0\]\.dlc/);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('returns 403 when the vehicle and device pair is not allowed', async () => {
    process.env.RAW_CAN_ALLOWED_PAIRS = '3:VCL003';
    const res = await post();
    expect(res.status).toBe(403);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('returns 403 when the vehicle matches but the device does not', async () => {
    const other = body();
    other.deviceId = 'VCL999';
    const res = await post(other);
    expect(res.status).toBe(403);
  });

  it('returns 202 with the acknowledgement for a new batch', async () => {
    const before = Date.now();
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: true,
      batchId: BATCH_ID,
      acceptedFrames: 2,
      ackSequence: 8422,
      serverReceivedAtMs: 1790742600311,
      status: 'stored',
    });

    const [batch, receivedAtMs] = store.insertBatch.mock.calls[0];
    expect(batch.batchId).toBe(BATCH_ID);
    expect(batch.frames).toHaveLength(2);
    expect(receivedAtMs).toBeGreaterThanOrEqual(before);
    expect(receivedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('returns 200 with duplicate: true for an already stored batch', async () => {
    store.insertBatch.mockResolvedValue({
      duplicate: true,
      overlap: false,
      ackSequence: 8422,
      acceptedFrames: 2,
      serverReceivedAtMs: 1790742600000,
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, duplicate: true, ackSequence: 8422 });
  });

  it('flags an overlapping batch but still acknowledges it', async () => {
    store.insertBatch.mockResolvedValue({
      duplicate: false,
      overlap: true,
      ackSequence: 8422,
      acceptedFrames: 2,
      serverReceivedAtMs: 1790742600311,
    });
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body.overlap).toBe(true);
  });

  it('returns 500 without leaking the error when the store fails', async () => {
    store.insertBatch.mockRejectedValue(new Error('connection refused to db-host:5432'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/db-host|connection/);
  });
});
