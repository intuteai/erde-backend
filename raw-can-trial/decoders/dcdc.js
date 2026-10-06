// raw-can-trial/decoders/dcdc.js
// DCDC status frames 0x1800D08F / 0x1801D08F (Intel), ported as-is from the app.

// 0x1800D08F
const parseDcdcStatus1 = (buffer) => {
  if (buffer.length < 8) return { error: 'DCDC_Status1 too short' };

  const modeRaw = buffer[0] & 0x03;
  const mode =
    modeRaw === 0 ? 'stop' :
    modeRaw === 1 ? 'running' :
    modeRaw === 2 ? 'failure' :
    'reserved';

  const faultsRaw = buffer.readUInt16LE(1);
  const faults = {
    inputUndervoltage: (faultsRaw & (1 << 0)) !== 0,
    inputOvervoltage: (faultsRaw & (1 << 1)) !== 0,
    inputOvercurrent: (faultsRaw & (1 << 2)) !== 0,
    outputUndervoltage: (faultsRaw & (1 << 3)) !== 0,
    outputOvervoltage: (faultsRaw & (1 << 4)) !== 0,
    outputOvercurrent: (faultsRaw & (1 << 5)) !== 0,
    moduleOverTemp: (faultsRaw & (1 << 6)) !== 0,
    reducedPower: (faultsRaw & (1 << 7)) !== 0,
  };

  const inputVoltageRaw = buffer.readUInt16LE(3);
  const inputCurrentRaw = buffer.readUInt8(5);
  const versionRaw = buffer.readUInt8(6);
  const live = buffer.readUInt8(7);

  return {
    raw: [...buffer],
    modeRaw,
    mode,
    faultsRaw,
    faults,
    inputVoltageRaw,
    inputVoltageV: inputVoltageRaw * 0.1,
    inputCurrentRaw,
    inputCurrentA: inputCurrentRaw * 0.1,
    versionRaw,
    live,
  };
};

// 0x1801D08F
const parseDcdcStatus2 = (buffer) => {
  if (buffer.length < 8) return { error: 'DCDC_Status2 too short' };

  const outputVoltageRaw = buffer.readUInt16LE(0);
  const outputCurrentRaw = buffer.readUInt16LE(2);
  const maxTempRaw = buffer.readUInt8(4);
  const reserve = buffer.readUInt8(7);

  return {
    raw: [...buffer],
    outputVoltageRaw,
    outputVoltageV: outputVoltageRaw * 0.1,
    outputCurrentRaw,
    outputCurrentA: outputCurrentRaw * 0.1,
    maxTempRaw,
    maxTempC: maxTempRaw - 40,
    reserve,
  };
};

module.exports = { parseDcdcStatus1, parseDcdcStatus2 };
