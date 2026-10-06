// raw-can-trial/tests/decoders/airPump.test.js
const { parseAirPumpStatus1, parseAirPumpStatus2 } = require('../../decoders/airPump');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0x18FF1BA6 parseAirPumpStatus1', () => {
  test('decodes fault bits, temps and LE values', () => {
    const r = parseAirPumpStatus1(hex('21 5A 100E 6400 50 00'));
    expect(r).toMatchObject({
      raw: [0x21, 0x5a, 0x10, 0x0e, 0x64, 0x00, 0x50, 0x00],
      faultsByte0: 0x21,
      faults: {
        overcurrent: true,
        overvoltage: false,
        overload: false,
        undervoltage: false,
        breakage: false,
        short: true,
        shortage: false,
        overweight: false,
      },
      hasFault: true,
      motorTempRaw: 90,
      motorTempC: 50,
      inputVoltageRaw: 3600,
      inputCurrentRaw: 100,
      controllerTempRaw: 80,
      controllerTempC: 40,
      controllerFaultSignalRaw: 0,
      controllerFault: false,
    });
    expect(r.inputVoltageV).toBeCloseTo(360, 10);
    expect(r.inputCurrentA).toBeCloseTo(10, 10);
  });

  test('controller fault only when byte7 is exactly 1', () => {
    expect(parseAirPumpStatus1(hex('00 00 0000 0000 00 01'))).toMatchObject({ controllerFault: true, hasFault: true });
    expect(parseAirPumpStatus1(hex('00 00 0000 0000 00 02'))).toMatchObject({ controllerFault: false, hasFault: false });
  });

  test('short payload', () => {
    expect(parseAirPumpStatus1(Buffer.alloc(7))).toStrictEqual({ error: 'AirPumpStatus1 (0x18FF1BA6) too short' });
  });
});

describe('0x18FF1CA6 parseAirPumpStatus2', () => {
  test('decodes speed offset, voltage, current and unsigned torque', () => {
    const r = parseAirPumpStatus2(hex('7017 C409 3200 FFFF'));
    expect(r).toMatchObject({
      raw: [0x70, 0x17, 0xc4, 0x09, 0x32, 0x00, 0xff, 0xff],
      speedRaw: 6000,
      motorSpeedRpm: 0,
      outputVoltageRaw: 2500,
      outputCurrentRaw: 50,
      torqueRaw: 65535,
      motorTorqueNm: 65535,
    });
    expect(r.outputVoltageV).toBeCloseTo(250, 10);
    expect(r.outputCurrentA).toBeCloseTo(5, 10);
    expect(parseAirPumpStatus2(Buffer.alloc(8)).motorSpeedRpm).toBe(-3000);
  });

  test('short payload', () => {
    expect(parseAirPumpStatus2(Buffer.alloc(2))).toStrictEqual({ error: 'AirPumpStatus2 (0x18FF1CA6) too short' });
  });
});
