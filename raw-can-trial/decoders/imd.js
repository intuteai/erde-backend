// raw-can-trial/decoders/imd.js
// Insulation monitor 0x1819A1A4, ported as-is from the app.

// Riso_Data (bits 5-6) and OP_Type (bit 6) overlap, as in the app.
const parseImd = (buf) => {
  if (buf.length < 8) return { error: 'IMD too short' };

  const b0 = buf[0];

  const Insulation_Alarm_1 = (b0 >> 0) & 1;
  const Insulation_Alarm_2 = (b0 >> 1) & 1;
  const Battery_OV_Alarm = (b0 >> 2) & 1;
  const Riso_Data = (b0 >> 5) & 0x03;
  const OP_Type = (b0 >> 6) & 1;
  const Monitoring_Status = (b0 >> 7) & 1;

  const Riso_Positive_raw = buf.readUInt16BE(1);
  const BAT_Voltage_raw = buf.readUInt16BE(3);
  const Riso_Negative_raw = buf.readUInt16BE(5);
  const Counter = buf.readUInt8(7);

  return {
    Insulation_Alarm_1,
    Insulation_Alarm_2,
    Battery_OV_Alarm,
    Riso_Data,
    OP_Type,
    Monitoring_Status,

    Riso_Positive: Riso_Positive_raw,
    BAT_Voltage: BAT_Voltage_raw * 0.1,
    Riso_Negative: Riso_Negative_raw,
    Counter,
  };
};

module.exports = { parseImd };
