// tests/exportResilience.test.js
// Regression tests for incident 2026-10-16: an abandoned CSV export left a transaction
// "idle in transaction" for 27 h, which blocked ALTER TABLE live_values and stalled ingest.
// No real database is used.

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { gzipWrite, gzipEnd, rollbackAndRelease } = require('../utils/streamExport');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// Spins up an HTTP server whose handler streams via the export helpers, exactly like
// the export routes: gz.pipe(res) + awaited gzipWrite per chunk + gzipEnd.
function startExportServer({ chunks, chunkBytes }) {
  const outcome = {};
  const server = http.createServer(async (req, res) => {
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(res);
    let written = 0;
    try {
      for (let i = 0; i < chunks; i++) {
        // incompressible payload so backpressure actually kicks in
        await gzipWrite(gz, crypto.randomBytes(chunkBytes).toString('hex') + '\n', res);
        written++;
      }
      await gzipEnd(gz, res);
      outcome.result = 'completed';
    } catch (err) {
      gz.destroy();
      outcome.result = 'rejected';
      outcome.code = err.code;
    } finally {
      outcome.written = written;
      outcome.done?.();
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, outcome })));
}

const settled = (outcome, ms) =>
  new Promise((resolve, reject) => {
    if (outcome.result) return resolve();
    const t = setTimeout(() => reject(new Error(`export loop did not settle within ${ms} ms (hung)`)), ms);
    outcome.done = () => { clearTimeout(t); resolve(); };
  });

describe('streamExport helpers', () => {
  it('completes a normal download and the client receives valid gzip', async () => {
    const { server, outcome } = await startExportServer({ chunks: 20, chunkBytes: 64 * 1024 });
    const body = await new Promise((resolve, reject) => {
      http.get({ port: server.address().port }, (res) => {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve(Buffer.concat(parts)));
      }).on('error', reject);
    });
    await settled(outcome, 5000);
    server.close();
    expect(outcome.result).toBe('completed');
    expect(outcome.written).toBe(20);
    expect(zlib.gunzipSync(body).toString().split('\n').filter(Boolean)).toHaveLength(20);
  });

  it('REGRESSION: rejects (does not hang) when the client disconnects mid-download', async () => {
    const { server, outcome } = await startExportServer({ chunks: 10_000, chunkBytes: 256 * 1024 });
    await new Promise((resolve) => {
      const req = http.get({ port: server.address().port }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); }); // user closes the tab
      });
      req.on('error', () => {});
    });
    await settled(outcome, 3000); // old code: never settles
    server.close();
    expect(outcome.result).toBe('rejected');
    expect(outcome.code).toBe('CLIENT_DISCONNECTED');
    expect(outcome.written).toBeLessThan(10_000);
  });

  it('rejects immediately if the response is already gone', async () => {
    const gz = zlib.createGzip();
    const res = { destroyed: true, writableEnded: false, on() {}, off() {}, once() {} };
    await expect(gzipWrite(gz, 'x', res)).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });
    await expect(gzipEnd(gz, res)).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });
    gz.destroy();
  });

  it('does not leak event listeners across many backpressured writes', async () => {
    const { server, outcome } = await startExportServer({ chunks: 60, chunkBytes: 128 * 1024 });
    const warnings = [];
    const onWarn = (w) => warnings.push(w);
    process.on('warning', onWarn);
    await new Promise((resolve, reject) => {
      http.get({ port: server.address().port }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    await settled(outcome, 10000);
    process.off('warning', onWarn);
    server.close();
    expect(outcome.result).toBe('completed');
    expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toHaveLength(0);
  });
});

describe('rollbackAndRelease', () => {
  it('rolls back and returns a healthy connection to the pool', async () => {
    const client = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    await rollbackAndRelease(client, logger, 'test');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection when ROLLBACK fails (unknown state)', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('terminated')), release: jest.fn() };
    await rollbackAndRelease(client, logger, 'test');
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('is a no-op without a client', async () => {
    await expect(rollbackAndRelease(null, logger, 'test')).resolves.toBeUndefined();
  });
});

describe('pool safety net: idle_in_transaction_session_timeout', () => {
  afterEach(() => jest.resetModules());

  const loadPoolWith = (envValue) => {
    jest.resetModules();
    if (envValue === undefined) delete process.env.DB_IDLE_IN_TX_TIMEOUT;
    else process.env.DB_IDLE_IN_TX_TIMEOUT = envValue;
    const handlers = {};
    jest.doMock('pg', () => ({
      Pool: jest.fn().mockImplementation(() => ({
        on: (evt, fn) => { handlers[evt] = fn; },
        query: jest.fn().mockResolvedValue({ rows: [] }),
        connect: jest.fn(),
      })),
    }));
    jest.doMock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const db = require('../config/postgres');
    return { db, handlers };
  };

  it('sets a 5min idle-in-transaction timeout on every new connection by default', async () => {
    const { db, handlers } = loadPoolWith(undefined);
    await db.query('SELECT 1');
    const client = { on: jest.fn(), query: jest.fn().mockResolvedValue({}) };
    handlers.connect(client);
    expect(client.query).toHaveBeenCalledWith(
      `SELECT set_config('idle_in_transaction_session_timeout', $1, false)`,
      ['5min']
    );
  });

  it('honours DB_IDLE_IN_TX_TIMEOUT and passes it as a bound parameter (never spliced into SQL)', async () => {
    const { db, handlers } = loadPoolWith("2min'; DROP TABLE x; --");
    await db.query('SELECT 1');
    const client = { on: jest.fn(), query: jest.fn().mockResolvedValue({}) };
    handlers.connect(client);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).not.toMatch(/DROP/);
    expect(params).toEqual(["2min'; DROP TABLE x; --"]);
  });

  it('attaches a permanent error listener so a dropped in-use connection cannot crash the process', async () => {
    const { EventEmitter } = require('events');
    const { db, handlers } = loadPoolWith(undefined);
    await db.query('SELECT 1');
    const client = Object.assign(new EventEmitter(), { query: jest.fn().mockResolvedValue({}) });
    handlers.connect(client);
    // An EventEmitter with no 'error' listener throws synchronously on emit — that is the crash.
    expect(() => client.emit('error', new Error('terminating connection due to idle-in-transaction timeout'))).not.toThrow();
    expect(require('../utils/logger').warn).toHaveBeenCalled();
  });

  it('a failing SET is logged, not thrown (connection still usable)', async () => {
    const { db, handlers } = loadPoolWith(undefined);
    await db.query('SELECT 1');
    const client = { on: jest.fn(), query: jest.fn().mockRejectedValue(new Error('boom')) };
    expect(() => handlers.connect(client)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(require('../utils/logger').error).toHaveBeenCalled();
  });
});

describe('customer routes run each transaction on ONE dedicated connection', () => {
  afterEach(() => jest.resetModules());

  const buildApp = (clientQuery) => {
    jest.resetModules();
    const client = { query: jest.fn(clientQuery), release: jest.fn() };
    const poolQuery = jest.fn().mockResolvedValue({ rows: [] });
    jest.doMock('../config/postgres', () => ({ query: poolQuery, getClient: jest.fn().mockResolvedValue(client) }));
    jest.doMock('../middleware/auth', () => (req, _res, next) => { req.user = { user_id: 1, role: 'admin' }; next(); });
    jest.doMock('../middleware/checkPermission', () => () => (_req, _res, next) => next());
    jest.doMock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/c', require('../routes/customer'));
    return { app, client, poolQuery };
  };

  it('POST: BEGIN…COMMIT on the same client, released afterwards, nothing on the shared pool', async () => {
    const { app, client, poolQuery } = buildApp(async (sql) => {
      if (/FROM roles/.test(sql)) return { rows: [{ role_id: 3 }] };
      if (/INSERT INTO users/.test(sql)) return { rows: [{ user_id: 9 }] };
      if (/INSERT INTO customer_master/.test(sql)) return { rows: [{ customer_id: 42 }] };
      return { rows: [] };
    });
    const res = await require('supertest')(app).post('/c').send({ company_name: 'Acme', email: 'a@b.c' });
    expect(res.status).toBe(201);
    const sqls = client.query.mock.calls.map(([s]) => s.trim().split(/\s+/)[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(poolQuery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('POST failure: ROLLBACK on the same client and still released', async () => {
    const { app, client } = buildApp(async (sql) => {
      if (/FROM roles/.test(sql)) return { rows: [{ role_id: 3 }] };
      if (/INSERT INTO users/.test(sql)) throw new Error('duplicate key value violates unique constraint');
      return { rows: [] };
    });
    const res = await require('supertest')(app).post('/c').send({ company_name: 'Acme', email: 'a@b.c' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email already exists');
    expect(client.query.mock.calls.map(([s]) => s)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('DELETE not found: ROLLBACK + 404 + released exactly once', async () => {
    const { app, client } = buildApp(async () => ({ rows: [] }));
    const res = await require('supertest')(app).delete('/c/77');
    expect(res.status).toBe(404);
    expect(client.query.mock.calls.map(([s]) => s)).toEqual(['BEGIN', expect.stringMatching(/SELECT user_id/), 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
