// raw-can-trial/tests/decoders/bms.test.js
const bms = require('../../decoders/bms');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('normalizeSocPercent', () => {
  test('keeps 0..100, divides 100..10000 by 100, clamps the rest', () => {
    expect(bms.normalizeSocPercent(55)).toBe(55);
    expect(bms.normalizeSocPercent(500)).toBe(5); // 0.1% branch is unreachable
    expect(bms.normalizeSocPercent(20000)).toBe(100);
    expect(bms.normalizeSocPercent(-5)).toBe(0);
    expect(bms.normalizeSocPercent(NaN)).toBe(0);
  });
});

describe('0x141 parseBms1', () => {
  test('decodes 2-bit contactors, state, flag and HVIL bits', () => {
    const r = bms.parseBms1(hex('E4 1B 00 15 03 81 0F 00'));
    expect(r).toMatchObject({
      CONT_1_PRECHG: 0, CONT_2_HS_STRING1: 1, CONT_3_LS_STRING1: 2, CONT_4_HS_STRING2: 3,
      CONT_5_LS_STRING2: 3, CONT_6_HS_STRING3: 2, CONT_7_LS_STRING3: 1, CONT_8_EXT_Contactor: 0,
      CONT_9_EXT_Contactor: 0, CONT_12_EXT_Contactor: 0,
      BMS_STATE: 5, CHARGE_FULL_FLAG: 1, No_BATT_PACK_Connected: 3,
      HVIL_1_Status: 1, HVIL_2_Status: 0, HVIL_7_Status: 0, HVIL_8_Status: 1,
      HVIL_9_Status: 1, HVIL_10_Status: 1, HVIL_11_Status: 1, HVIL_12_Status: 1,
    });
    expect(Object.keys(r)).toHaveLength(27);
  });

  test('short payload', () => {
    expect(bms.parseBms1(hex('00 00 00 00 00 00 00'))).toStrictEqual({ error: 'BMS_1 too short' });
  });
});

describe('0x142 parseBms2', () => {
  test('decodes SOC/SOH/cycles/version', () => {
    const r = bms.parseBms2(hex('1F40 2710 0064 0102'));
    expect(r.SOC).toBeCloseTo(80, 10);
    expect(r.SOH).toBeCloseTo(100, 10);
    expect(r.CYCLE_COUNT).toBe(100);
    expect(r.Software_Version).toBeCloseTo(2.58, 10);
  });

  test('SOC above 100% is divided by 100 again (app quirk)', () => {
    expect(bms.parseBms2(hex('2711 0000 0000 0000')).SOC).toBeCloseTo(1.0001, 10);
    expect(bms.parseBms2(hex('FFFF 0000 0000 0000')).SOC).toBeCloseTo(6.5535, 10);
  });

  test('short payload', () => {
    expect(bms.parseBms2(Buffer.alloc(0))).toStrictEqual({ error: 'BMS_2 too short' });
  });
});

describe('0x143 parseBms3', () => {
  test('decodes and negates signed pack current', () => {
    const r = bms.parseBms3(hex('07D0 0FA0 3A98 FF9C'));
    expect(r.RAH).toBeCloseTo(100, 10);
    expect(r.CAH).toBeCloseTo(200, 10);
    expect(r.PACKVOLTAGE).toBeCloseTo(750, 10);
    expect(r.PACKCURRENT).toBeCloseTo(5, 10);
    expect(bms.parseBms3(hex('0000 0000 0000 0064')).PACKCURRENT).toBeCloseTo(-5, 10);
  });

  test('zero current comes out as -0, as in the app', () => {
    expect(Object.is(bms.parseBms3(Buffer.alloc(8)).PACKCURRENT, -0)).toBe(true);
  });

  test('short payload', () => {
    expect(bms.parseBms3(Buffer.alloc(7))).toStrictEqual({ error: 'BMS_3 too short' });
  });
});

describe('0x144 parseBms4', () => {
  test('raw BE uint16 cell voltages', () => {
    expect(bms.parseBms4(hex('0D48 0CE4 0D16 0064'))).toStrictEqual({
      MAX_CELL_VOLTAGE: 3400, MIN_CELL_VOLTAGE: 3300, AVG_CELL_VOLTAGE: 3350, CELL_VOLTAGE_DIFFERENCE: 100,
    });
    expect(bms.parseBms4(Buffer.alloc(3))).toStrictEqual({ error: 'BMS_4 too short' });
  });
});

describe('0x145 parseBms5', () => {
  test('signed temps with -273 offset, difference also offset (app quirk)', () => {
    expect(bms.parseBms5(hex('2220 FFE0 2240 0020'))).toStrictEqual({
      MAXTEMP: 0, MINTEMP: -274, AVGTEMP: 1, TEMP_DIFFERENCE: -272,
    });
    expect(bms.parseBms5(Buffer.alloc(1))).toStrictEqual({ error: 'BMS_5 too short' });
  });
});

describe('0x146 parseBms6', () => {
  test('signed discharge limits, unsigned charge limits', () => {
    const r = bms.parseBms6(hex('FF38 00C8 8000 FFFF'));
    expect(r.OCD_LIMIT).toBeCloseTo(-10, 10);
    expect(r.OCC_LIMIT).toBeCloseTo(10, 10);
    expect(r.PEAK_OCD_LIMIT).toBeCloseTo(-1638.4, 10);
    expect(r.PEAK_OCC_LIMIT).toBeCloseTo(3276.75, 10);
    expect(bms.parseBms6(Buffer.alloc(0))).toStrictEqual({ error: 'BMS_6 too short' });
  });
});

describe('0x147 parseBms7', () => {
  test('int8 busbar temps', () => {
    expect(bms.parseBms7(hex('80 7F FF 00 19 E7 01 02'))).toStrictEqual({
      Temp_1_String1_Positive_Busbar: -128,
      Temp_2_String1_Negative_Busbar: 127,
      Temp_3_String2_Positive_Busbar: -1,
      Temp_4_String2_Negative_Busbar: 0,
      Temp_5_String3_Positive_Busbar: 25,
      Temp_6_String3_Negative_Busbar: -25,
      Temp_7_Reserved: 1,
      Temp_8_Reserved: 2,
    });
    expect(bms.parseBms7(Buffer.alloc(7))).toStrictEqual({ error: 'BMS_7 too short' });
  });
});

describe('0x148 parseBms8Faults', () => {
  test('works with only 5 bytes', () => {
    const r = bms.parseBms8Faults(hex('E4 1B 00 C0 03'));
    expect(r).toMatchObject({
      CELLOVERVOLTAGEF1: 0, CELLUNDERVOLTAGEF1: 1, PACKOVERVOLTAGEF1: 2, PACKUNDERVOLTAGEF1: 3,
      CHARGEOVERCURRENTF1: 3, DISCHARGEOVERCURRENTF1: 2, CHARGEOVERTEMPERATUREF1: 1, CHARGEUNDERTEMPERATUREF1: 0,
      IMD_F1: 0, HVILF1: 3, SOCLOWF1: 0, CONTACTORWELDF1: 3,
    });
    expect(Object.keys(r)).toHaveLength(17);
  });

  test('short payload is under 5 bytes', () => {
    expect(bms.parseBms8Faults(Buffer.alloc(4))).toStrictEqual({ error: 'BMS_8 too short' });
  });
});

describe('0x149 parseBms9Energy / 0x154 parseBms14Ah', () => {
  test('uint32 BE * 0.01', () => {
    const r = bms.parseBms9Energy(hex('00002710 FFFFFFFF'));
    expect(r.Kwh_Used).toBeCloseTo(100, 10);
    expect(r.Kwh_Pump).toBeCloseTo(42949672.95, 6);
    const a = bms.parseBms14Ah(hex('000003E8 00000001'));
    expect(a.Ah_Used).toBeCloseTo(10, 10);
    expect(a.Ah_Pump).toBeCloseTo(0.01, 10);
    expect(bms.parseBms9Energy(Buffer.alloc(4))).toStrictEqual({ error: 'BMS_9 too short' });
    expect(bms.parseBms14Ah(Buffer.alloc(4))).toStrictEqual({ error: 'BMS_14 too short' });
  });
});

describe('0x150 parseBms10Currents', () => {
  test('signed currents * 0.05', () => {
    const r = bms.parseBms10Currents(hex('0064 FF9C 0000 8000'));
    expect(r.CS_1).toBeCloseTo(5, 10);
    expect(r.CS_2).toBeCloseTo(-5, 10);
    expect(r.CS_3).toBe(0);
    expect(r.Pack_Current).toBeCloseTo(-1638.4, 10);
    expect(bms.parseBms10Currents(Buffer.alloc(2))).toStrictEqual({ error: 'BMS_10 too short' });
  });
});

describe('0x151 / 0x152 string voltages', () => {
  test('uint16 BE * 0.05', () => {
    const a = bms.parseBms11StringVoltages(hex('3A98 3A98 0000 FFFF'));
    expect(a.String_Voltage_1).toBeCloseTo(750, 10);
    expect(a.String_Voltage_3).toBe(0);
    expect(a.String_Voltage_4).toBeCloseTo(3276.75, 10);
    const b = bms.parseBms12StringVoltages(hex('0014 0028 003C 3A98'));
    expect(b.String_Voltage_5).toBeCloseTo(1, 10);
    expect(b.String_Voltage_7).toBeCloseTo(3, 10);
    expect(b.Pack_Voltage).toBeCloseTo(750, 10);
    expect(bms.parseBms11StringVoltages(Buffer.alloc(6))).toStrictEqual({ error: 'BMS_11 too short' });
    expect(bms.parseBms12StringVoltages(Buffer.alloc(6))).toStrictEqual({ error: 'BMS_12 too short' });
  });
});

describe('0x153 parseBms13SocStrings', () => {
  test('works with 6 bytes and normalises each SOC', () => {
    const r = bms.parseBms13SocStrings(hex('1388 2711 0000'));
    expect(r.SOC1).toBeCloseTo(50, 10);
    expect(r.SOC2).toBeCloseTo(1.0001, 10);
    expect(r.SOC3).toBe(0);
    expect(bms.parseBms13SocStrings(Buffer.alloc(5))).toStrictEqual({ error: 'BMS_13 too short' });
  });
});
