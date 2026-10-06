// raw-can-trial/tests/decoders/hcu.test.js
const { parseHcuCommandP } = require('../../decoders/hcu');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0x142CFF27 parseHcuCommandP', () => {
  test('decodes enable command and LE setpoints', () => {
    const r = parseHcuCommandP(hex('AA 8813 F401 00 00 00'));
    expect(r).toMatchObject({
      raw: [0xaa, 0x88, 0x13, 0xf4, 0x01, 0, 0, 0],
      enableCmd: 0xaa,
      enable: 'start',
      vSetRaw: 5000,
      iLimitRaw: 500,
    });
    expect(r.vSetV).toBeCloseTo(500, 10);
    expect(r.iLimitA).toBeCloseTo(50, 10);
  });

  test.each([[0x55, 'stop'], [0x00, 'unknown'], [0xff, 'unknown']])('enable byte %i -> %s', (b0, enable) => {
    expect(parseHcuCommandP(Buffer.from([b0, 0, 0, 0, 0, 0, 0, 0])).enable).toBe(enable);
  });

  test('short payload', () => {
    expect(parseHcuCommandP(Buffer.alloc(5))).toStrictEqual({ error: 'HCU_Command_P too short' });
  });
});
