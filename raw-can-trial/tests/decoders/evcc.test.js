// raw-can-trial/tests/decoders/evcc.test.js
const {
  parseEvcc510Like,
  parseEvcc511Like,
  parseEvcc512Like,
  APP_BIGINT_ERROR,
} = require('../../decoders/evcc');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const BIG = { bigInt: true };

describe('0x1011F456 parseEvcc510Like', () => {
  test('throws like the app (buffer@5.7.1 has no readBigUInt64LE) by default', () => {
    expect(() => parseEvcc510Like(Buffer.alloc(8))).toThrow(TypeError);
    expect(() => parseEvcc510Like(Buffer.alloc(8))).toThrow(APP_BIGINT_ERROR);
  });

  test('decodes LE bit fields with bigInt option', () => {
    expect(parseEvcc510Like(hex('C5 9E 6D B2 11 22 33 44'), BIG)).toStrictEqual({
      raw: [0xc5, 0x9e, 0x6d, 0xb2, 0x11, 0x22, 0x33, 0x44],
      EVCC_PwrStat: 1,
      EVCC_SocketStat: 0,
      Evse_Stat: 1,
      Evse_ChgFinished: 1,
      Evse_Processing: 1,
      Evse_IsolStat: 2,
      Evse_TransferType: 7,
      Evse_Notification: 2,
      Evse_PwrDelivery: 1,
      EVCC_ChgFinished: 0,
      EVCC_CPStat: 3,
      EVCC_S2_OnStat: 1,
      EVCC_PDStat: 1,
      EVCC_DutyValue: 50,
      EVCC_LockStat: 1,
      EVCC_AagValue: 0x11,
      EVCC_ErrorCode: 0x22,
      EVCC_StepNum: 0x33,
      Evse_MaxDelay: 0x44,
    });
  });

  test('short payload returns the error object (no throw)', () => {
    expect(parseEvcc510Like(Buffer.alloc(7))).toStrictEqual({ error: 'EVCC 0x510-like frame too short' });
  });
});

describe('0x1819F456 parseEvcc511Like', () => {
  test('LE uint16 * 0.1 (no BigInt involved)', () => {
    const r = parseEvcc511Like(hex('D007 FA00 8813 6400'));
    expect(r.raw).toStrictEqual([0xd0, 0x07, 0xfa, 0x00, 0x88, 0x13, 0x64, 0x00]);
    expect(r.Evse_MaxVolt_V).toBeCloseTo(200, 10);
    expect(r.Evse_MaxCurr_A).toBeCloseTo(25, 10);
    expect(r.Evse_OutVolt_V).toBeCloseTo(500, 10);
    expect(r.EVSE_OutCurr_A).toBeCloseTo(10, 10);
  });

  test('short payload', () => {
    expect(parseEvcc511Like(Buffer.alloc(0))).toStrictEqual({ error: 'EVCC 0x511-like frame too short' });
  });
});

describe('0x181DF456 parseEvcc512Like', () => {
  test('throws like the app by default', () => {
    expect(() => parseEvcc512Like(Buffer.alloc(8))).toThrow(APP_BIGINT_ERROR);
  });

  test('decodes with bigInt option', () => {
    const r = parseEvcc512Like(hex('E803 0A00 E803 27 41'), BIG);
    expect(r).toMatchObject({
      raw: [0xe8, 0x03, 0x0a, 0x00, 0xe8, 0x03, 0x27, 0x41],
      Evse_MaxPwr_W: 10000,
      EVCC_Lock_status: 3,
      EVCC_Lock_alarm: 1,
      Secc_DCAC_ChgMode: 2,
      EVSE_EVCC_ChgFinished: 1,
      Secc_ACMaxCurrentValue: 32,
    });
    expect(r.Evse_MinVolt_V).toBeCloseTo(100, 10);
    expect(r.Evse_MinCurr_A).toBeCloseTo(1, 10);
  });

  test('short payload', () => {
    expect(parseEvcc512Like(Buffer.alloc(7))).toStrictEqual({ error: 'EVCC 0x512-like frame too short' });
  });
});
