// raw-can-trial/tests/validateBatch.test.js
const { validateBatch, MAX_FRAMES } = require('../validateBatch');

const BATCH_ID = '09218c79-2207-465e-8f93-3fd2f8f30c85';

const frame = (sequence, overrides = {}) => ({
  sequence,
  receivedAtMs: 1790742600012 + sequence,
  monotonicMs: 1842022 + sequence,
  canId: 0x18ffc13a,
  isExtended: true,
  dlc: 8,
  dataBase64: 'AQIDBAUGBwg=', // 01 02 03 04 05 06 07 08
  direction: 'rx',
  channel: 0,
  ...overrides,
});

const validBody = () => ({
  schemaVersion: '1.0',
  vehicleMasterId: 2,
  deviceId: 'VCL001',
  sessionId: '9bbf8dd3-2db0-4e4c-a39f-488c919421d2',
  batchId: BATCH_ID,
  sentAtMs: 1790742600250,
  firstSequence: 8421,
  lastSequence: 8423,
  frames: [frame(8421), frame(8422), frame(8423)],
});

describe('validateBatch: accepted batches', () => {
  it('accepts the contract example', () => {
    const result = validateBatch(validBody(), {});
    expect(result.ok).toBe(true);
    expect(result.batch).toMatchObject({
      vehicleMasterId: 2,
      deviceId: 'VCL001',
      batchId: BATCH_ID,
      firstSequence: 8421,
      lastSequence: 8423,
    });
    expect(result.batch.frames).toHaveLength(3);
  });

  it('accepts a matching idempotency header', () => {
    expect(validateBatch(validBody(), { 'x-idempotency-key': BATCH_ID }).ok).toBe(true);
  });

  it('accepts a zero-length payload', () => {
    const body = validBody();
    body.frames[0] = frame(8421, { dlc: 0, dataBase64: '' });
    expect(validateBatch(body, {}).ok).toBe(true);
  });

  it('accepts an unknown CAN id and a standard 11-bit id', () => {
    const body = validBody();
    body.frames[0] = frame(8421, { canId: 0x7ff, isExtended: false });
    body.frames[1] = frame(8422, { canId: 0x1abcdef0 });
    expect(validateBatch(body, {}).ok).toBe(true);
  });

  it('accepts a single frame and exactly the maximum number of frames', () => {
    const one = validBody();
    one.frames = [frame(1)];
    one.firstSequence = 1;
    one.lastSequence = 1;
    expect(validateBatch(one, {}).ok).toBe(true);

    const max = validBody();
    max.frames = Array.from({ length: MAX_FRAMES }, (_, i) => frame(i + 1));
    max.firstSequence = 1;
    max.lastSequence = MAX_FRAMES;
    expect(validateBatch(max, {}).ok).toBe(true);
  });

  it('accepts sequences with gaps between frames', () => {
    const body = validBody();
    body.frames = [frame(10), frame(15), frame(16)];
    body.firstSequence = 10;
    body.lastSequence = 16;
    expect(validateBatch(body, {}).ok).toBe(true);
  });
});

describe('validateBatch: rejected batches', () => {
  const cases = [
    ['body is not an object', () => null, /body/],
    ['body is an array', () => [], /body/],
    ['wrong schemaVersion', (b) => { b.schemaVersion = '2.0'; }, /schemaVersion/],
    ['vehicleMasterId is zero', (b) => { b.vehicleMasterId = 0; }, /vehicleMasterId/],
    ['vehicleMasterId is a string', (b) => { b.vehicleMasterId = '2'; }, /vehicleMasterId/],
    ['vehicleMasterId is fractional', (b) => { b.vehicleMasterId = 2.5; }, /vehicleMasterId/],
    ['deviceId is empty', (b) => { b.deviceId = '  '; }, /deviceId/],
    ['deviceId is missing', (b) => { delete b.deviceId; }, /deviceId/],
    ['sessionId is not a UUID', (b) => { b.sessionId = 'abc'; }, /sessionId/],
    ['batchId is not a UUID', (b) => { b.batchId = 'not-a-uuid'; }, /batchId/],
    ['sentAtMs is negative', (b) => { b.sentAtMs = -1; }, /sentAtMs/],
    ['firstSequence is a string', (b) => { b.firstSequence = '8421'; }, /firstSequence/],
    ['lastSequence is missing', (b) => { delete b.lastSequence; }, /lastSequence/],
    ['frames is not an array', (b) => { b.frames = {}; }, /frames/],
    ['frames is empty', (b) => { b.frames = []; }, /frames/],
    ['too many frames', (b) => {
      b.frames = Array.from({ length: MAX_FRAMES + 1 }, (_, i) => frame(i + 1));
      b.firstSequence = 1;
      b.lastSequence = MAX_FRAMES + 1;
    }, /frames/],
    ['a frame is not an object', (b) => { b.frames[1] = 5; }, /frames\[1\]/],
    ['sequence decreases', (b) => { b.frames[1].sequence = 8421; }, /frames\[1\]\.sequence/],
    ['sequence repeats', (b) => { b.frames[2].sequence = 8422; }, /frames\[2\]\.sequence/],
    ['firstSequence does not match', (b) => { b.firstSequence = 8420; }, /firstSequence/],
    ['lastSequence does not match', (b) => { b.lastSequence = 8424; }, /lastSequence/],
    ['receivedAtMs is missing', (b) => { delete b.frames[0].receivedAtMs; }, /frames\[0\]\.receivedAtMs/],
    ['monotonicMs is negative', (b) => { b.frames[0].monotonicMs = -5; }, /frames\[0\]\.monotonicMs/],
    ['isExtended is not boolean', (b) => { b.frames[0].isExtended = 1; }, /frames\[0\]\.isExtended/],
    ['standard id above 0x7FF', (b) => {
      b.frames[0].isExtended = false;
      b.frames[0].canId = 0x800;
    }, /frames\[0\]\.canId/],
    ['extended id above 0x1FFFFFFF', (b) => { b.frames[0].canId = 0x20000000; }, /frames\[0\]\.canId/],
    ['canId is negative', (b) => { b.frames[0].canId = -1; }, /frames\[0\]\.canId/],
    ['dlc above 8', (b) => { b.frames[0].dlc = 9; }, /frames\[0\]\.dlc/],
    ['dlc is fractional', (b) => { b.frames[0].dlc = 7.5; }, /frames\[0\]\.dlc/],
    ['dataBase64 is not a string', (b) => { b.frames[0].dataBase64 = [1, 2]; }, /frames\[0\]\.dataBase64/],
    ['dataBase64 has invalid characters', (b) => { b.frames[0].dataBase64 = 'AQID*AUGBwg='; }, /frames\[0\]\.dataBase64/],
    ['dataBase64 has bad padding', (b) => { b.frames[0].dataBase64 = 'AQIDBAUGBwg'; }, /frames\[0\]\.dataBase64/],
    ['payload length differs from dlc', (b) => { b.frames[0].dlc = 7; }, /frames\[0\]\.dataBase64/],
    ['direction is unknown', (b) => { b.frames[0].direction = 'in'; }, /frames\[0\]\.direction/],
    ['channel is negative', (b) => { b.frames[0].channel = -1; }, /frames\[0\]\.channel/],
  ];

  it.each(cases)('rejects when %s', (_name, mutate, reason) => {
    const body = validBody();
    const replaced = mutate(body);
    const result = validateBatch(replaced === undefined ? body : replaced, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it('rejects an idempotency header that differs from batchId', () => {
    const result = validateBatch(validBody(), {
      'x-idempotency-key': '11111111-2222-4333-8444-555555555555',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/x-idempotency-key/);
  });
});
