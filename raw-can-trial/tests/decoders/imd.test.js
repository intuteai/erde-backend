// raw-can-trial/tests/decoders/imd.test.js
const { parseImd } = require('../../decoders/imd');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0x1819A1A4 parseImd', () => {
  test('decodes flags and BE values', () => {
    const r = parseImd(hex('E7 03E8 0FA0 07D0 2A'));
    expect(r).toMatchObject({
      Insulation_Alarm_1: 1,
      Insulation_Alarm_2: 1,
      Battery_OV_Alarm: 1,
      Riso_Data: 3,
      OP_Type: 1,
      Monitoring_Status: 1,
      Riso_Positive: 1000,
      Riso_Negative: 2000,
      Counter: 42,
    });
    expect(r.BAT_Voltage).toBeCloseTo(400, 10);
  });

  test('Riso_Data and OP_Type share bit 6 (app quirk)', () => {
    const r = parseImd(hex('40 0000 0000 0000 00'));
    expect(r.Riso_Data).toBe(2);
    expect(r.OP_Type).toBe(1);
    expect(r.Monitoring_Status).toBe(0);
  });

  test('short payload', () => {
    expect(parseImd(Buffer.alloc(7))).toStrictEqual({ error: 'IMD too short' });
  });
});
