// raw-can-trial/tests/decoders/index.test.js
const { decodeFrame, KNOWN_CAN_IDS, canIdString } = require('../../decoders');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const FULL = Buffer.alloc(8);

// canId -> [partial keys, freshKey]
const TABLE = [
  [0x140, ['vcuContactorState'], 'vcu140'],
  [0x141, ['bms1'], 'bms1'],
  [0x142, ['bms2'], 'bms2'],
  [0x143, ['bms3'], 'bms3'],
  [0x144, ['bms4'], 'bms4'],
  [0x145, ['bms5'], 'bms5'],
  [0x146, ['bms6'], null],
  [0x147, ['bms7'], 'bms7'],
  [0x148, ['bms8Faults'], 'bms8'],
  [0x149, ['bms9Energy'], 'bms9'],
  [0x150, ['bms10Currents'], 'bms10'],
  [0x151, ['bms11StringVoltages'], 'bms11'],
  [0x152, ['bms12StringVoltages'], 'bms12'],
  [0x153, ['bms13SocStrings'], null],
  [0x154, ['bms14Ah'], null],
  [0x1819a1a4, ['imd'], 'imd'],
  [0x1800d08f, ['dcdcStatus1', 'dcdcVtgCur'], 'dcdcStatus1'],
  [0x1801d08f, ['dcdcStatus2', 'dcdcVtgCur'], 'dcdcStatus2'],
  [0x142cff27, ['hcuCommandP'], null],
  [0x18ffc13a, ['btmsStatus'], 'btmsStatus'],
  [0x18ff45f4, ['btmsCommand'], 'btmsCmd'],
  [0x18ff1ba6, ['airPumpStatus1'], 'air1'],
  [0x18ff1ca6, ['airPumpStatus2'], 'air2'],
  [0x1819f456, ['evcc'], 'evcc1EvseLimits'],
  [0x0c08a6a7, ['message411', 'motorBasic'], 'motor411'],
  [0x0c09a6a7, ['message412', 'motorBasic'], 'motor412'],
  [0x0c0aa6a7, ['message413', 'motorBasic'], 'motor413'],
];

describe('decodeFrame mapping', () => {
  test.each(TABLE)('0x%s -> keys %j, freshKey %s', (id, keys, freshKey) => {
    const out = decodeFrame(id, FULL);
    expect(out.freshKey).toBe(freshKey);
    expect(Object.keys(out.partial)).toStrictEqual(keys);
    expect(out.partial).not.toHaveProperty('rawFrame');
  });

  test('KNOWN_CAN_IDS covers every case', () => {
    expect(KNOWN_CAN_IDS).toHaveLength(29);
    expect([...KNOWN_CAN_IDS].sort()).toStrictEqual(
      [...TABLE.map(([id]) => id), 0x1011f456, 0x181df456].sort(),
    );
  });

  test.each([0x0, 0x13f, 0x155, 0x510, 0x511, 0x1011f555, 0x1819f555, 0xc08a6a8])('unknown id 0x%s -> null', (id) => {
    expect(decodeFrame(id, FULL)).toBeNull();
  });

  test('id string matches the app format (uppercase, no padding)', () => {
    expect(canIdString(0x0c08a6a7)).toBe('0xC08A6A7');
    expect(canIdString(0x140)).toBe('0x140');
    expect(canIdString(-1)).toBe('0xFFFFFFFF');
  });
});

describe('decodeFrame partial shapes', () => {
  test('BMS case wraps the parser result', () => {
    expect(decodeFrame(0x140, Buffer.from([3]))).toStrictEqual({
      freshKey: 'vcu140',
      partial: { vcuContactorState: { CONTACTOR_STATE_RAW: 3, CONTACTOR_STATE: 'charge_on' } },
    });
  });

  test('DCDC status1 copies input values into dcdcVtgCur', () => {
    const { partial } = decodeFrame(0x1800d08f, hex('01 0000 8813 32 00 00'));
    expect(partial.dcdcVtgCur).toStrictEqual({
      Input_Voltage: partial.dcdcStatus1.inputVoltageV,
      Input_Current: partial.dcdcStatus1.inputCurrentA,
    });
    expect(partial.dcdcVtgCur.Input_Voltage).toBeCloseTo(500, 10);
  });

  test('DCDC status2 short frame gives undefined dcdcVtgCur values', () => {
    expect(decodeFrame(0x1801d08f, Buffer.alloc(2)).partial).toStrictEqual({
      dcdcStatus2: { error: 'DCDC_Status2 too short' },
      dcdcVtgCur: { Output_Voltage: undefined, Output_Current: undefined },
    });
  });

  test('EVCC 511 is nested under evcc.evseLimits', () => {
    const { partial } = decodeFrame(0x1819f456, FULL);
    expect(Object.keys(partial.evcc)).toStrictEqual(['evseLimits']);
  });

  test('EVCC 510/512 full frames give parsingError but still set freshKey (app behaviour)', () => {
    expect(decodeFrame(0x1011f456, FULL)).toStrictEqual({
      freshKey: 'evcc1Control',
      partial: { parsingError: 'buf.readBigUInt64LE is not a function (it is undefined)' },
    });
    expect(decodeFrame(0x181df456, FULL).freshKey).toBe('evcc1EvseStatus2');
    expect(decodeFrame(0x181df456, FULL).partial).toHaveProperty('parsingError');
  });

  test('EVCC 510/512 short frames return the error object under evcc', () => {
    expect(decodeFrame(0x1011f456, Buffer.alloc(3)).partial).toStrictEqual({
      evcc: { control: { error: 'EVCC 0x510-like frame too short' } },
    });
  });

  test('EVCC 510/512 decode with bigInt option', () => {
    expect(decodeFrame(0x1011f456, FULL, { bigInt: true }).partial.evcc.control.EVCC_PwrStat).toBe(0);
    expect(decodeFrame(0x181df456, FULL, { bigInt: true }).partial.evcc.evseStatus2.Evse_MaxPwr_W).toBe(0);
  });

  test('motor 411 builds motorBasic', () => {
    expect(decodeFrame(0x0c08a6a7, hex('983A FC3A 343A 02 00')).partial.motorBasic).toStrictEqual({
      torqueRaw: 100,
      rpm: -100,
      statusWord: 0,
      running: true,
      direction: 'reverse',
      statusLabel: 'Running',
      hasFault: false,
      hasWarning: false,
    });
    const stopped = decodeFrame(0x0c08a6a7, hex('983A 983A 983A 03 00')).partial.motorBasic;
    expect(stopped).toMatchObject({ rpm: 0, running: false, direction: 'stopped', statusLabel: 'Stopped' });
  });

  test('motor 411 short frame reports Running (app quirk)', () => {
    expect(decodeFrame(0x0c08a6a7, Buffer.alloc(4)).partial).toStrictEqual({
      message411: { error: 'Invalid Msg411 Data' },
      motorBasic: {
        torqueRaw: undefined,
        rpm: undefined,
        statusWord: undefined,
        running: true,
        direction: 'stopped',
        statusLabel: 'Running',
        hasFault: false,
        hasWarning: false,
      },
    });
  });

  test('motor 412 maps temps into motorBasic', () => {
    const { partial } = decodeFrame(0x0c09a6a7, hex('E803 2C01 8813 50 28'));
    expect(partial.motorBasic).toMatchObject({ igbtTempC: 0, motorTempC: 40 });
    expect(partial.motorBasic.currentRaw).toBeCloseTo(100, 10);
  });

  test('motor 413 fault/warning roll-up ignores some bits (app quirk)', () => {
    // zeroOffsetFault alone is not part of hasFault
    expect(decodeFrame(0x0c0aa6a7, hex('04 00 00 46 00 00 00 00')).partial.motorBasic).toStrictEqual({
      hasFault: false,
      hasWarning: false,
      radTemp: 30,
    });
    expect(decodeFrame(0x0c0aa6a7, hex('00 40 08 28 00 00 00 00')).partial.motorBasic).toStrictEqual({
      hasFault: true,
      hasWarning: true,
      radTemp: 0,
    });
    expect(decodeFrame(0x0c0aa6a7, Buffer.alloc(0)).partial.motorBasic).toStrictEqual({
      hasFault: false,
      hasWarning: false,
      radTemp: undefined,
    });
  });
});
