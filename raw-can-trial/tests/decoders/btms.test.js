// raw-can-trial/tests/decoders/btms.test.js
const { parseBtmsCommand, parseBtmsStatus } = require('../../decoders/btms');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0x18FF45F4 parseBtmsCommand', () => {
  test('decodes byte0 fields, BE voltage at bytes 1-2, temp setpoint', () => {
    expect(parseBtmsCommand(hex('56 0258 00 41 00 07 99'))).toStrictEqual({
      raw: [0x56, 0x02, 0x58, 0x00, 0x41, 0x00, 0x07, 0x99],
      reqModeRaw: 2,
      hvReqRaw: 1,
      chargeRaw: 1,
      hvRelayRaw: 1,
      mode: 'heating',
      hvRequest: 'hv_off_request',
      chargeStatus: 'charging',
      bmsHvRelayState: 'closed',
      voltageRaw: 600,
      packVoltageV: 600,
      tempSetRaw: 0x41,
      tempSetC: 25,
      lifeCounter: 7,
      crc: 0x99,
    });
  });

  test('0xFFFF voltage and 0xFF temp are null; all-ones byte0 is invalid', () => {
    const r = parseBtmsCommand(hex('FF FFFF 00 FF 00 00 00'));
    expect(r.packVoltageV).toBeNull();
    expect(r.tempSetC).toBeNull();
    expect(r.mode).toBe('self_circulation');
    expect(r.hvRequest).toBe('invalid');
    expect(r.chargeStatus).toBe('invalid');
    expect(r.bmsHvRelayState).toBe('invalid');
  });

  test('short payload', () => {
    expect(parseBtmsCommand(Buffer.alloc(7))).toStrictEqual({ error: 'Invalid BTMS command frame' });
  });
});

describe('0x18FFC13A parseBtmsStatus', () => {
  test('decodes mode, temps, demand power and fault byte', () => {
    expect(parseBtmsStatus(hex('05 41 FF 11 22 000F 85'))).toStrictEqual({
      raw: [0x05, 0x41, 0xff, 0x11, 0x22, 0x00, 0x0f, 0x85],
      modeRaw: 1,
      hvRelayRaw: 1,
      tmsMode: 'cooling',
      hvRelayState: 'closed',
      outletWaterTempC: 25,
      inletWaterTempC: null,
      reserved4: 0x11,
      reserved5: 0x22,
      demandPowerRaw: 15,
      demandPowerKw: 1.5,
      faultCode: 5,
      faultLevelRaw: 2,
      faultLevel: 'level2',
    });
  });

  test('0xFFFF demand is null, fault level 3 is invalid', () => {
    const r = parseBtmsStatus(hex('0C 00 28 00 00 FFFF FF'));
    expect(r.demandPowerKw).toBeNull();
    expect(r.faultCode).toBe(0x3f);
    expect(r.faultLevel).toBe('invalid');
    expect(r.hvRelayState).toBe('invalid');
    expect(r.tmsMode).toBe('shutdown');
    expect(r.outletWaterTempC).toBe(-40);
    expect(r.inletWaterTempC).toBe(0);
  });

  test('short payload', () => {
    expect(parseBtmsStatus(Buffer.alloc(0))).toStrictEqual({ error: 'Invalid BTMS status frame' });
  });
});
