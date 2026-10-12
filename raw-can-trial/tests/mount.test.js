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
      body: Buffer.isBuffer(payload) ? payload : zlib.gzipSync(JSON.stringify(payload)),
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

describe('logging of rejected request bodies', () => {
  const logger = require('../../utils/logger');

  it('logs a body the parser rejects, with its reason and encoding, at most once per window', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const realNow = Date.now;
    let now = realNow() + 10 * 60_000; // a fresh logging window
    Date.now = () => now;
    try {
      const app = buildApp();
      const sendBad = () => request(app)
        .post(PATH)
        .set('x-api-key', KEY)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('this is not gzip data');

      expect((await sendBad()).status).toBe(400);
      expect((await sendBad()).status).toBe(400);
      const bodyLogs = () => warn.mock.calls.filter((c) => c[0] === '[raw-can] Request body rejected');
      expect(bodyLogs()).toHaveLength(1);
      // notLoggedSinceLast may include rejections from earlier tests in this file
      expect(bodyLogs()[0][1]).toMatchObject({ status: 400, contentEncoding: 'gzip' });

      now += 31_000;
      expect((await sendBad()).status).toBe(400);
      expect(bodyLogs()).toHaveLength(2);
      expect(bodyLogs()[1][1].notLoggedSinceLast).toBe(1);
    } finally {
      Date.now = realNow;
      warn.mockRestore();
    }
  });
});

describe('bodies compressed twice (React Native on Android)', () => {
  it('unwraps a double-gzipped batch and stores it', async () => {
    const twice = zlib.gzipSync(zlib.gzipSync(JSON.stringify(body())));
    const res = await postGzip(buildApp(), twice);
    expect(res.status).toBe(202);
    expect(store.insertBatch).toHaveBeenCalledTimes(1);
    expect(store.insertBatch.mock.calls[0][0].frames).toHaveLength(1);
  });

  it('still rejects a compressed body that is not JSON, and logs what it contained', async () => {
    const logger = require('../../utils/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 60_000; // a fresh logging window
    try {
      const res = await postGzip(buildApp(), zlib.gzipSync('[object ArrayBuffer]'));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ accepted: false, reason: 'entity.parse.failed' });
      const logged = warn.mock.calls.find((c) => c[0] === '[raw-can] Request body rejected');
      expect(logged[1].bodyPreview).toBe(Buffer.from('[object ArrayBuffer]').toString('hex'));
      expect(store.insertBatch).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
      warn.mockRestore();
    }
  });

  it('rejects a double-gzipped body that unwraps to more than 128 KiB', async () => {
    const big = body();
    big.padding = 'x'.repeat(129 * 1024);
    const res = await postGzip(buildApp(), zlib.gzipSync(zlib.gzipSync(JSON.stringify(big))));
    expect(res.status).toBe(413);
    expect(res.body.accepted).toBe(false);
  });
});

describe('compression is detected from the bytes, not the header', () => {
  const send = async (app, payload, headers) => {
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers },
        body: payload,
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const json = () => JSON.stringify(body());

  it('accepts plain JSON that is labelled gzip', async () => {
    const res = await send(buildApp(), json(), { 'content-encoding': 'gzip' });
    expect(res.status).toBe(202);
  });

  it('accepts gzip that is not labelled, from a build that reports stats', async () => {
    const res = await send(buildApp(), zlib.gzipSync(json()), { 'x-raw-can-stats': '{}' });
    expect(res.status).toBe(202);
  });

  it('accepts gzip inside gzip without a label, from a build that reports stats', async () => {
    const res = await send(buildApp(), zlib.gzipSync(zlib.gzipSync(json())), { 'x-raw-can-stats': '{}' });
    expect(res.status).toBe(202);
  });

  it('rejects three layers of gzip', async () => {
    const res = await send(buildApp(), zlib.gzipSync(zlib.gzipSync(zlib.gzipSync(json()))), { 'content-encoding': 'gzip' });
    expect(res.status).toBe(400);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('tells the build that compresses in JavaScript to stop (403), without storing', async () => {
    const res = await send(buildApp(), zlib.gzipSync(json()), {});
    expect(res.status).toBe(403);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });

  it('answers 401, not 403, when that build sends a wrong key', async () => {
    const res = await send(buildApp(), zlib.gzipSync(json()), { 'x-api-key': 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects a body that is not sent as application/json', async () => {
    const res = await send(buildApp(), json(), { 'content-type': 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);
    expect(store.insertBatch).not.toHaveBeenCalled();
  });
});

describe('client stats header', () => {
  const logger = require('../../utils/logger');

  const withFreshLogWindow = async (offsetMs, fn) => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    try {
      await fn(() => info.mock.calls.filter((c) => c[0] === '[raw-can] Client stats'));
    } finally {
      Date.now = realNow;
      info.mockRestore();
    }
  };

  it('logs the tablet\'s reported timings with the batch, at most once per window', async () => {
    await withFreshLogWindow(3 * 60 * 60_000, async (statsLogs) => {
      const app = buildApp();
      const stats = JSON.stringify({ queuedBatches: 12, gzipMs: 40, requestMs: 310 });
      const post = () => request(app).post(PATH).set('x-api-key', KEY).set('x-raw-can-stats', stats).send(body());
      expect((await post()).status).toBe(202);
      expect((await post()).status).toBe(202);

      expect(statsLogs()).toHaveLength(1);
      expect(statsLogs()[0][1]).toMatchObject({
        client: { queuedBatches: 12, gzipMs: 40, requestMs: 310 },
        frames: 1,
        lastSequence: 1,
      });
      expect(typeof statsLogs()[0][1].sinceFirstFrameS).toBe('number');
    });
  });

  it('ignores a stats header that is not a JSON object, and still stores the batch', async () => {
    await withFreshLogWindow(5 * 60 * 60_000, async (statsLogs) => {
      const app = buildApp();
      for (const bad of ['not json', '[1,2]', '"text"', `{"a":"${'x'.repeat(2100)}"}`]) {
        const res = await request(app).post(PATH).set('x-api-key', KEY).set('x-raw-can-stats', bad).send(body());
        expect(res.status).toBe(202);
      }
      expect(statsLogs()).toHaveLength(0);
    });
  });
});
