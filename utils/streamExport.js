// utils/streamExport.js
// Backpressure-safe gzip streaming for cursor-based CSV exports.
//
// Why this exists: the old per-route gzipWrite() waited only for 'drain' / 'error'.
// When the browser disconnected mid-download, gzip stopped draining and never errored,
// so the export loop awaited forever — leaving BEGIN…FETCH open ("idle in transaction")
// and the pool client unreleased. That open transaction blocked an ALTER TABLE on
// live_values, which stalled all telemetry inserts (incident 2026-10-16).
// These helpers reject as soon as the HTTP response is gone, so callers always reach
// their catch → ROLLBACK → release path.

class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected during export');
    this.name = 'ClientDisconnectedError';
    this.code = 'CLIENT_DISCONNECTED';
  }
}

const isGone = (res) => !!res && (res.destroyed || res.writableEnded || res.socket?.destroyed);

// Resolves when `gz` can accept more data; rejects on gzip error or client disconnect.
function gzipWrite(gz, data, res) {
  return new Promise((resolve, reject) => {
    if (gz.destroyed || isGone(res)) return reject(new ClientDisconnectedError());

    if (gz.write(data)) return resolve();

    const cleanup = () => {
      gz.off('drain', onDrain);
      gz.off('error', onError);
      gz.off('close', onClose);
      res?.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new ClientDisconnectedError()); };

    gz.on('drain', onDrain);
    gz.on('error', onError);
    gz.on('close', onClose);
    res?.on('close', onClose);
  });
}

// Ends the gzip stream; resolves once the response has been fully handed off.
function gzipEnd(gz, res) {
  return new Promise((resolve, reject) => {
    if (gz.destroyed || isGone(res)) return reject(new ClientDisconnectedError());

    const cleanup = () => {
      gz.off('finish', onFinish);
      gz.off('error', onError);
      res?.off('close', onClose);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new ClientDisconnectedError()); };

    gz.once('finish', onFinish);
    gz.once('error', onError);
    res?.once('close', onClose);
    gz.end();
  });
}

// Shared catch/finally for cursor exports: always ends the transaction and frees the
// connection. If ROLLBACK itself fails the connection is in an unknown state, so it is
// destroyed (release(true)) instead of being returned to the pool.
async function rollbackAndRelease(client, logger, label) {
  if (!client) return;
  let destroy = false;
  try {
    await client.query('ROLLBACK');
  } catch (e) {
    destroy = true;
    logger.error(`${label}: ROLLBACK failed, discarding connection: ${e.message}`);
  }
  client.release(destroy ? true : undefined);
}

module.exports = { gzipWrite, gzipEnd, rollbackAndRelease, ClientDisconnectedError };
