// raw-can-trial/tests/decoders/motor.test.js
const { parseMsg411, parseMsg412, parseMsg413 } = require('../../decoders/motor');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('0xC08A6A7 parseMsg411', () => {
  test('LE values with -15000 offset and status bits', () => {
    expect(parseMsg411(hex('983A FC3A 343A 61 03'))).toStrictEqual({
      N_motorTorqueLim: 0,
      N_motorTorque: 100,
      N_motorSpeed: -100,
      St_motorDirection: 1,
      St_motorMode: 0,
      St_motor: 2,
      St_MCU_enable: 1,
      St_MCUdriverPermit: 1,
      St_MCUoffPermit: 1,
    });
  });

  test('all zeros gives -15000 everywhere', () => {
    expect(parseMsg411(Buffer.alloc(8)).N_motorSpeed).toBe(-15000);
  });

  test('short payload', () => {
    expect(parseMsg411(Buffer.alloc(7))).toStrictEqual({ error: 'Invalid Msg411 Data' });
  });
});

describe('0xC09A6A7 parseMsg412', () => {
  test('LE * 0.1 and temp offsets', () => {
    const r = parseMsg412(hex('E803 2C01 8813 50 28'));
    expect(r.N_MotorACCurrent).toBeCloseTo(100, 10);
    expect(r.N_MotorACVoltage).toBeCloseTo(30, 10);
    expect(r.N_MCUDCVoltage).toBeCloseTo(500, 10);
    expect(r.N_motorTemp).toBe(40);
    expect(r.N_MCUTemp).toBe(0);
  });

  test('short payload', () => {
    expect(parseMsg412(Buffer.alloc(0))).toStrictEqual({ error: 'Invalid Msg412 Data' });
  });
});

describe('0xC0AA6A7 parseMsg413', () => {
  test('fault bits, radiator temp and motor numbering', () => {
    const r = parseMsg413(hex('04 40 08 46 00 00 21 07'));
    expect(r).toMatchObject({
      hardwareDriverFailure: 0,
      zeroOffsetFault: 1,
      moduleOverTemperatureWarning: 1,
      overspeedFault: 0,
      canOfflineFailure: 1,
      encoderFailure: 0,
      radTemp: 30,
      motorQuantity: 1,
      motorNum: 2,
      mcuNumber: 7,
    });
    expect(Object.keys(r)).toHaveLength(25);
  });

  test('all bits set', () => {
    const r = parseMsg413(hex('FF FF FF FF FF FF FF FF'));
    expect(r.lowVoltageUndervoltageFault).toBe(1);
    expect(r.overspeedFault).toBe(1);
    expect(r.encoderFailure).toBe(1);
    expect(r.radTemp).toBe(215);
    expect(r.motorQuantity).toBe(15);
    expect(r.motorNum).toBe(15);
  });

  test('short payload', () => {
    expect(parseMsg413(Buffer.alloc(3))).toStrictEqual({ error: 'Invalid Msg413 Data' });
  });
});
