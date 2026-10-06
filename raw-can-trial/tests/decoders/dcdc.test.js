// raw-can-trial/tests/decoders/dcdc.test.js
const { parseDcdcStatus1, parseDcdcStatus2 } = require('../../decoders/dcdc');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0x1800D08F parseDcdcStatus1', () => {
  test('decodes mode, LE fault word and input values', () => {
    const r = parseDcdcStatus1(hex('01 8100 8813 32 05 7B'));
    expect(r).toMatchObject({
      raw: [0x01, 0x81, 0x00, 0x88, 0x13, 0x32, 0x05, 0x7b],
      modeRaw: 1,
      mode: 'running',
      faultsRaw: 0x81,
      faults: {
        inputUndervoltage: true,
        inputOvervoltage: false,
        inputOvercurrent: false,
        outputUndervoltage: false,
        outputOvervoltage: false,
        outputOvercurrent: false,
        moduleOverTemp: false,
        reducedPower: true,
      },
      inputVoltageRaw: 5000,
      inputCurrentRaw: 50,
      versionRaw: 5,
      live: 123,
    });
    expect(r.inputVoltageV).toBeCloseTo(500, 10);
    expect(r.inputCurrentA).toBeCloseTo(5, 10);
  });

  test.each([[0, 'stop'], [2, 'failure'], [3, 'reserved'], [0xfc, 'stop']])('byte0 %i -> %s', (b0, mode) => {
    expect(parseDcdcStatus1(Buffer.from([b0, 0, 0, 0, 0, 0, 0, 0])).mode).toBe(mode);
  });

  test('fault bits above bit 7 map to no flag', () => {
    const r = parseDcdcStatus1(hex('00 00FF 0000 00 00 00'));
    expect(r.faultsRaw).toBe(0xff00);
    expect(Object.values(r.faults).some(Boolean)).toBe(false);
  });

  test('short payload', () => {
    expect(parseDcdcStatus1(Buffer.alloc(7))).toStrictEqual({ error: 'DCDC_Status1 too short' });
  });
});

describe('0x1801D08F parseDcdcStatus2', () => {
  test('decodes output values and temp offset', () => {
    const r = parseDcdcStatus2(hex('E803 2C01 64 0000 09'));
    expect(r).toMatchObject({
      raw: [0xe8, 0x03, 0x2c, 0x01, 0x64, 0, 0, 0x09],
      outputVoltageRaw: 1000,
      outputCurrentRaw: 300,
      maxTempRaw: 100,
      maxTempC: 60,
      reserve: 9,
    });
    expect(r.outputVoltageV).toBeCloseTo(100, 10);
    expect(r.outputCurrentA).toBeCloseTo(30, 10);
    expect(parseDcdcStatus2(Buffer.alloc(8)).maxTempC).toBe(-40);
  });

  test('short payload', () => {
    expect(parseDcdcStatus2(Buffer.alloc(0))).toStrictEqual({ error: 'DCDC_Status2 too short' });
  });
});
