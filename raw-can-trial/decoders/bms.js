// raw-can-trial/decoders/bms.js
// BMS frames 0x141-0x154, ported as-is from the app's BatteryBluetoothProvider.
// Quirks are kept on purpose so backend output matches the app field by field.

/** App's SOC normaliser. The 0.1% branch can never run (the 0.01% branch wins). */
const normalizeSocPercent = (v) => {
  if (!Number.isFinite(v)) return 0;
  if (v >= 0 && v <= 100) return v;
  if (v > 100 && v <= 10000) return v / 100;
  if (v > 100 && v <= 1000) return v / 10;
  return Math.max(0, Math.min(100, v));
};

// 0x141 (BMS_1)
const parseBms1 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_1 too short' };

  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const b3 = buf[3];
  const b4 = buf[4];
  const b5 = buf[5];
  const b6 = buf[6];

  const u2 = (b, shift) => (b >> shift) & 0x03;

  return {
    CONT_1_PRECHG: u2(b0, 0),
    CONT_2_HS_STRING1: u2(b0, 2),
    CONT_3_LS_STRING1: u2(b0, 4),
    CONT_4_HS_STRING2: u2(b0, 6),

    CONT_5_LS_STRING2: u2(b1, 0),
    CONT_6_HS_STRING3: u2(b1, 2),
    CONT_7_LS_STRING3: u2(b1, 4),
    CONT_8_EXT_Contactor: u2(b1, 6),

    CONT_9_EXT_Contactor: u2(b2, 0),
    CONT_10_EXT_Contactor: u2(b2, 2),
    CONT_11_EXT_Contactor: u2(b2, 4),
    CONT_12_EXT_Contactor: u2(b2, 6),

    BMS_STATE: b3 & 0x0f,
    CHARGE_FULL_FLAG: (b3 >> 4) & 0x01,

    No_BATT_PACK_Connected: b4,

    HVIL_1_Status: (b5 >> 0) & 1,
    HVIL_2_Status: (b5 >> 1) & 1,
    HVIL_3_Status: (b5 >> 2) & 1,
    HVIL_4_Status: (b5 >> 3) & 1,
    HVIL_5_Status: (b5 >> 4) & 1,
    HVIL_6_Status: (b5 >> 5) & 1,
    HVIL_7_Status: (b5 >> 6) & 1,
    HVIL_8_Status: (b5 >> 7) & 1,

    HVIL_9_Status: (b6 >> 0) & 1,
    HVIL_10_Status: (b6 >> 1) & 1,
    HVIL_11_Status: (b6 >> 2) & 1,
    HVIL_12_Status: (b6 >> 3) & 1,
  };
};

// 0x142 (BMS_2)
const parseBms2 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_2 too short' };

  const SOC_raw = buf.readUInt16BE(0);
  const SOH_raw = buf.readUInt16BE(2);
  const CYC_raw = buf.readUInt16BE(4);
  const SW_raw = buf.readUInt16BE(6);

  const SOC = normalizeSocPercent(SOC_raw * 0.01);

  return {
    SOC,
    SOH: SOH_raw * 0.01,
    CYCLE_COUNT: CYC_raw,
    Software_Version: SW_raw * 0.01,
  };
};

// 0x143 (BMS_3). PACKCURRENT is negated, so a zero reading gives -0.
const parseBms3 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_3 too short' };

  const RAH_raw = buf.readUInt16BE(0);
  const CAH_raw = buf.readUInt16BE(2);
  const PV_raw = buf.readUInt16BE(4);
  const PC_raw = buf.readInt16BE(6);

  return {
    RAH: RAH_raw * 0.05,
    CAH: CAH_raw * 0.05,
    PACKVOLTAGE: PV_raw * 0.05,
    PACKCURRENT: -(PC_raw * 0.05),
  };
};

// 0x144 (BMS_4)
const parseBms4 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_4 too short' };

  return {
    MAX_CELL_VOLTAGE: buf.readUInt16BE(0),
    MIN_CELL_VOLTAGE: buf.readUInt16BE(2),
    AVG_CELL_VOLTAGE: buf.readUInt16BE(4),
    CELL_VOLTAGE_DIFFERENCE: buf.readUInt16BE(6),
  };
};

// 0x145 (BMS_5). TEMP_DIFFERENCE also gets the -273 offset, as in the app.
const parseBms5 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_5 too short' };

  const maxRaw = buf.readInt16BE(0);
  const minRaw = buf.readInt16BE(2);
  const avgRaw = buf.readInt16BE(4);
  const difRaw = buf.readUInt16BE(6);

  return {
    MAXTEMP: maxRaw * 0.03125 - 273,
    MINTEMP: minRaw * 0.03125 - 273,
    AVGTEMP: avgRaw * 0.03125 - 273,
    TEMP_DIFFERENCE: difRaw * 0.03125 - 273,
  };
};

// 0x146 (BMS_6)
const parseBms6 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_6 too short' };

  const OCD_raw = buf.readInt16BE(0);
  const OCC_raw = buf.readUInt16BE(2);
  const PEAK_OCD_raw = buf.readInt16BE(4);
  const PEAK_OCC_raw = buf.readUInt16BE(6);

  return {
    OCD_LIMIT: OCD_raw * 0.05,
    OCC_LIMIT: OCC_raw * 0.05,
    PEAK_OCD_LIMIT: PEAK_OCD_raw * 0.05,
    PEAK_OCC_LIMIT: PEAK_OCC_raw * 0.05,
  };
};

// 0x147 (BMS_7)
const parseBms7 = (buf) => {
  if (buf.length < 8) return { error: 'BMS_7 too short' };

  return {
    Temp_1_String1_Positive_Busbar: buf.readInt8(0),
    Temp_2_String1_Negative_Busbar: buf.readInt8(1),
    Temp_3_String2_Positive_Busbar: buf.readInt8(2),
    Temp_4_String2_Negative_Busbar: buf.readInt8(3),
    Temp_5_String3_Positive_Busbar: buf.readInt8(4),
    Temp_6_String3_Negative_Busbar: buf.readInt8(5),
    Temp_7_Reserved: buf.readInt8(6),
    Temp_8_Reserved: buf.readInt8(7),
  };
};

// 0x148 (BMS_8). Needs only 5 bytes.
const parseBms8Faults = (buf) => {
  if (buf.length < 5) return { error: 'BMS_8 too short' };

  const get2 = (byteIndex, shift) => (buf[byteIndex] >> shift) & 0x03;

  return {
    CELLOVERVOLTAGEF1: get2(0, 0),
    CELLUNDERVOLTAGEF1: get2(0, 2),
    PACKOVERVOLTAGEF1: get2(0, 4),
    PACKUNDERVOLTAGEF1: get2(0, 6),

    CHARGEOVERCURRENTF1: get2(1, 0),
    DISCHARGEOVERCURRENTF1: get2(1, 2),
    CHARGEOVERTEMPERATUREF1: get2(1, 4),
    CHARGEUNDERTEMPERATUREF1: get2(1, 6),

    DISCHARGEOVERTEMPERATUREF1: get2(2, 0),
    DISCHARGEUNDERTEMPERATUREF1: get2(2, 2),
    CELLVOLTAGEDIFFERENCEF1: get2(2, 4),
    IMD_F1: get2(2, 6),

    SOCLOWF1: get2(3, 0),
    SHORTCIRCUITF1: get2(3, 2),
    THERMALRUNAWAYF1: get2(3, 4),
    HVILF1: get2(3, 6),

    CONTACTORWELDF1: get2(4, 0),
  };
};

// 0x149 (BMS_9)
const parseBms9Energy = (buf) => {
  if (buf.length < 8) return { error: 'BMS_9 too short' };

  const kwhUsedRaw = buf.readUInt32BE(0);
  const kwhPumpRaw = buf.readUInt32BE(4);

  return {
    Kwh_Used: kwhUsedRaw * 0.01,
    Kwh_Pump: kwhPumpRaw * 0.01,
  };
};

// 0x150 (BMS_10)
const parseBms10Currents = (buf) => {
  if (buf.length < 8) return { error: 'BMS_10 too short' };

  const cs1 = buf.readInt16BE(0);
  const cs2 = buf.readInt16BE(2);
  const cs3 = buf.readInt16BE(4);
  const pc = buf.readInt16BE(6);

  return {
    CS_1: cs1 * 0.05,
    CS_2: cs2 * 0.05,
    CS_3: cs3 * 0.05,
    Pack_Current: pc * 0.05,
  };
};

// 0x151 (BMS_11)
const parseBms11StringVoltages = (buf) => {
  if (buf.length < 8) return { error: 'BMS_11 too short' };

  return {
    String_Voltage_1: buf.readUInt16BE(0) * 0.05,
    String_Voltage_2: buf.readUInt16BE(2) * 0.05,
    String_Voltage_3: buf.readUInt16BE(4) * 0.05,
    String_Voltage_4: buf.readUInt16BE(6) * 0.05,
  };
};

// 0x152 (BMS_12)
const parseBms12StringVoltages = (buf) => {
  if (buf.length < 8) return { error: 'BMS_12 too short' };

  return {
    String_Voltage_5: buf.readUInt16BE(0) * 0.05,
    String_Voltage_6: buf.readUInt16BE(2) * 0.05,
    String_Voltage_7: buf.readUInt16BE(4) * 0.05,
    Pack_Voltage: buf.readUInt16BE(6) * 0.05,
  };
};

// 0x153 (BMS_13). Needs only 6 bytes.
const parseBms13SocStrings = (buf) => {
  if (buf.length < 6) return { error: 'BMS_13 too short' };

  const soc1 = buf.readUInt16BE(0) * 0.01;
  const soc2 = buf.readUInt16BE(2) * 0.01;
  const soc3 = buf.readUInt16BE(4) * 0.01;

  return {
    SOC1: normalizeSocPercent(soc1),
    SOC2: normalizeSocPercent(soc2),
    SOC3: normalizeSocPercent(soc3),
  };
};

// 0x154 (BMS_14)
const parseBms14Ah = (buf) => {
  if (buf.length < 8) return { error: 'BMS_14 too short' };

  const ahUsedRaw = buf.readUInt32BE(0);
  const ahPumpRaw = buf.readUInt32BE(4);

  return {
    Ah_Used: ahUsedRaw * 0.01,
    Ah_Pump: ahPumpRaw * 0.01,
  };
};

module.exports = {
  normalizeSocPercent,
  parseBms1,
  parseBms2,
  parseBms3,
  parseBms4,
  parseBms5,
  parseBms6,
  parseBms7,
  parseBms8Faults,
  parseBms9Energy,
  parseBms10Currents,
  parseBms11StringVoltages,
  parseBms12StringVoltages,
  parseBms13SocStrings,
  parseBms14Ah,
};
