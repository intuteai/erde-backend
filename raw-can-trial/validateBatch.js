// raw-can-trial/validateBatch.js
// Checks a raw CAN batch against the v0.1 data contract.
// Pure function: no I/O, so every rule can be unit tested.

const SCHEMA_VERSION = '1.0';
const MAX_FRAMES = 200;
const MAX_STANDARD_ID = 0x7ff;
const MAX_EXTENDED_ID = 0x1fffffff;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

const reject = (reason) => ({ ok: false, reason });

/** Returns a reason string if the frame is invalid, otherwise null. */
const checkFrame = (f, i, prevSequence) => {
  const at = `frames[${i}]`;

  if (!isObject(f)) return `${at} must be an object`;
  if (!isNonNegInt(f.sequence)) return `${at}.sequence must be a non-negative integer`;
  if (prevSequence !== null && f.sequence <= prevSequence) {
    return `${at}.sequence must be greater than the previous frame's`;
  }
  if (!isNonNegInt(f.receivedAtMs)) return `${at}.receivedAtMs must be a non-negative integer`;
  if (!isNonNegInt(f.monotonicMs)) return `${at}.monotonicMs must be a non-negative integer`;
  if (typeof f.isExtended !== 'boolean') return `${at}.isExtended must be a boolean`;

  const maxId = f.isExtended ? MAX_EXTENDED_ID : MAX_STANDARD_ID;
  if (!isNonNegInt(f.canId) || f.canId > maxId) {
    return `${at}.canId must be an integer 0..0x${maxId.toString(16).toUpperCase()}`;
  }

  if (!Number.isInteger(f.dlc) || f.dlc < 0 || f.dlc > 8) return `${at}.dlc must be an integer 0..8`;
  if (typeof f.dataBase64 !== 'string' || !BASE64_RE.test(f.dataBase64)) {
    return `${at}.dataBase64 must be a Base64 string`;
  }
  if (Buffer.from(f.dataBase64, 'base64').length !== f.dlc) {
    return `${at}.dataBase64 must decode to exactly dlc (${f.dlc}) bytes`;
  }

  if (f.direction !== 'rx' && f.direction !== 'tx') return `${at}.direction must be "rx" or "tx"`;
  if (!isNonNegInt(f.channel)) return `${at}.channel must be a non-negative integer`;
  return null;
};

/**
 * @param {unknown} body    parsed JSON request body
 * @param {object}  headers request headers (lower-case keys, as Express provides)
 * @returns {{ ok: true, batch: object } | { ok: false, reason: string }}
 */
const validateBatch = (body, headers = {}) => {
  if (!isObject(body)) return reject('body must be a JSON object');

  if (body.schemaVersion !== SCHEMA_VERSION) return reject(`schemaVersion must be "${SCHEMA_VERSION}"`);
  if (!isPosInt(body.vehicleMasterId)) return reject('vehicleMasterId must be a positive integer');
  if (typeof body.deviceId !== 'string' || !body.deviceId.trim()) {
    return reject('deviceId must be a non-empty string');
  }
  if (typeof body.sessionId !== 'string' || !UUID_RE.test(body.sessionId)) {
    return reject('sessionId must be a UUID');
  }
  if (typeof body.batchId !== 'string' || !UUID_RE.test(body.batchId)) {
    return reject('batchId must be a UUID');
  }

  const idempotencyKey = headers['x-idempotency-key'];
  if (idempotencyKey !== undefined && idempotencyKey !== body.batchId) {
    return reject('x-idempotency-key header must equal batchId');
  }

  for (const field of ['sentAtMs', 'firstSequence', 'lastSequence']) {
    if (!isNonNegInt(body[field])) return reject(`${field} must be a non-negative integer`);
  }

  const { frames } = body;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES) {
    return reject(`frames must be an array of 1..${MAX_FRAMES} frames`);
  }

  let prevSequence = null;
  for (let i = 0; i < frames.length; i++) {
    const problem = checkFrame(frames[i], i, prevSequence);
    if (problem) return reject(problem);
    prevSequence = frames[i].sequence;
  }

  if (body.firstSequence !== frames[0].sequence) {
    return reject('firstSequence must equal the first frame\'s sequence');
  }
  if (body.lastSequence !== frames[frames.length - 1].sequence) {
    return reject('lastSequence must equal the last frame\'s sequence');
  }

  return {
    ok: true,
    batch: {
      vehicleMasterId: body.vehicleMasterId,
      deviceId: body.deviceId,
      sessionId: body.sessionId.toLowerCase(),
      batchId: body.batchId.toLowerCase(),
      sentAtMs: body.sentAtMs,
      firstSequence: body.firstSequence,
      lastSequence: body.lastSequence,
      frames,
    },
  };
};

module.exports = { validateBatch, MAX_FRAMES };
