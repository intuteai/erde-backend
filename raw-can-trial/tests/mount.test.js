// raw-can-trial/tests/mount.test.js
// Mounts the trial the way app.js does (before the global 10mb JSON parser)
// and checks the trial's parser, limiter and error handler stay on its path.
jest.mock('../store');

const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const store = require('../store');
const { mount } = require('..');

const KEY = 'mount-test-key';
const PATH = '/api/telemetry/raw-can/v1';

const body = () => ({
  schemaVersion: '1.0',
  vehicleMasterId: 2,
  deviceId: 'VCL001',
  sessionId: '9bbf8dd3-2db0-4e4c-a39f-488c919421d2',
  batchId: '09218c79-2207-465e-8f93-3fd2f8f30c85',
  sentAtMs: 1790742600250,
  firstSequence: 1,
  lastSequence: 1,
  frames: [{
    sequence: 1,
    receivedAtMs: 1790742600012,
    monotonicMs: 1842022,
    canId: 0x141,
    isExtended: false,
    dlc: 8,
    dataBase64: 'AQIDBAUGBwg=',
    direction: 'rx',
    channel: 0,
  }],
});

// supertest JSON-encodes Buffers, so compressed bodies go over a real socket.
const postGzip = async (app, payload) => {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-api-key': KEY,
      },
      body: zlib.gzipSync(JSON.stringify(payload)),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
};

const buildApp = () => {
  const app = express();
  mount(app);
  app.use(express.json({ limit: '10mb' }));
  app.post('/api/other', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  return app;
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
    duplicate: false, overlap: false, ackSequence: 1, acceptedFrames: 1, serverReceivedAtMs: 1,
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('mount(app)', () => {
  it('accepts a valid batch at the contract path', async () => {
    const res = await request(buildApp()).post(PATH).set('x-api-key', KEY).send(body());
    expect(res.status).toBe(202);
  });

  it('accepts a gzip-compressed body', async () => {
    const res = await postGzip(buildApp(), body());
    expect(res.status).toBe(202);
  });

  it('returns 413 in the trial format for a body over 128 KiB', async () => {
    const big = body();
    big.padding = 'x'.repeat(129 * 1024);
    const res = await request(buildApp()).post(PATH).set('x-api-key', KEY).send(big);
    expect(res.status).toBe(413);
    expect(res.body.accepted).toBe(false);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('applies the 128 KiB limit after gzip is inflated', async () => {
    const big = body();
    big.padding = 'x'.repeat(129 * 1024);
    const res = await postGzip(buildApp(), big); // compresses to a few hundred bytes
    expect(res.status).toBe(413);
    expect(res.body.accepted).toBe(false);
  });

  it('returns 400 in the trial format for malformed JSON', async () => {
    const res = await request(buildApp())
      .post(PATH)
      .set('x-api-key', KEY)
      .set('Content-Type', 'application/json')
      .send('{"schemaVersion": ');
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);
  });

  it('rate limits the trial path at 600 requests a minute', async () => {
    const app = buildApp();
    process.env.RAW_CAN_ENABLED = 'false'; // cheap 503s are enough to count requests
    for (let i = 0; i < 600; i++) {
      const res = await request(app).post(PATH).send({});
      expect(res.status).toBe(503);
    }
    const res = await request(app).post(PATH).send({});
    expect(res.status).toBe(429);
  });

  it('leaves other routes on the app\'s own parser and limits', async () => {
    const res = await request(buildApp())
      .post('/api/other')
      .send({ padding: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(200);
    expect(res.body.size).toBeGreaterThan(200 * 1024);
  });
});
