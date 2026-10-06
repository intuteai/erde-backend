// raw-can-trial/tests/decoders/vcu.test.js
const { parseVcuContactorState } = require('../../decoders/vcu');

describe('0x140 parseVcuContactorState', () => {
  test.each([
    [0, 'disabled'],
    [1, 'discharge_on'],
    [2, 'unknown'], // app comment says charging, code says unknown
    [3, 'charge_on'],
    [0xff, 'unknown'],
  ])('byte0 %i -> %s', (raw, state) => {
    expect(parseVcuContactorState(Buffer.from([raw, 0, 0, 0, 0, 0, 0, 0]))).toStrictEqual({
      CONTACTOR_STATE_RAW: raw,
      CONTACTOR_STATE: state,
    });
  });

  test('one byte is enough', () => {
    expect(parseVcuContactorState(Buffer.from([1]))).toStrictEqual({
      CONTACTOR_STATE_RAW: 1,
      CONTACTOR_STATE: 'discharge_on',
    });
  });

  test('empty payload', () => {
    expect(parseVcuContactorState(Buffer.alloc(0))).toStrictEqual({ error: '0x140 too short' });
  });
});
