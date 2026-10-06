// raw-can-trial/decoders/airPump.js
// Air pump DCAC frames 0x18FF1BA6 / 0x18FF1CA6 (Intel), ported as-is from the app.

// 0x18FF1BA6
const parseAirPumpStatus1 = (b) => {
  if (b.length < 8) return { error: 'AirPumpStatus1 (0x18FF1BA6) too short' };

  const faultsByte0 = b.readUInt8(0);

  const faults = {
    overcurrent: (faultsByte0 & (1 << 0)) !== 0,
    overvoltage: (faultsByte0 & (1 << 1)) !== 0,
    overload: (faultsByte0 & (1 << 2)) !== 0,
    undervoltage: (faultsByte0 & (1 << 3)) !== 0,
    breakage: (faultsByte0 & (1 << 4)) !== 0,
    short: (faultsByte0 & (1 << 5)) !== 0,
    shortage: (faultsByte0 & (1 << 6)) !== 0,
    overweight: (faultsByte0 & (1 << 7)) !== 0,
  };

  const motorTempRaw = b.readUInt8(1);
  const motorTempC = motorTempRaw - 40;

  const inputVoltageRaw = b.readUInt16LE(2);
  const inputVoltageV = inputVoltageRaw * 0.1;

  const inputCurrentRaw = b.readUInt16LE(4);
  const inputCurrentA = inputCurrentRaw * 0.1;

  const controllerTempRaw = b.readUInt8(6);
  const controllerTempC = controllerTempRaw - 40;

  const controllerFaultSignalRaw = b.readUInt8(7);
  const controllerFault = controllerFaultSignalRaw === 1;

  const hasFault = controllerFault || Object.values(faults).some(Boolean);

  return {
    raw: [...b],

    faultsByte0,
    faults,
    hasFault,

    motorTempRaw,
    motorTempC,

    inputVoltageRaw,
    inputVoltageV,

    inputCurrentRaw,
    inputCurrentA,

    controllerTempRaw,
    controllerTempC,

    controllerFaultSignalRaw,
    controllerFault,
  };
};

// 0x18FF1CA6. Torque is read unsigned, as in the app.
const parseAirPumpStatus2 = (b) => {
  if (b.length < 8) return { error: 'AirPumpStatus2 (0x18FF1CA6) too short' };

  const speedRaw = b.readUInt16LE(0);
  const motorSpeedRpm = speedRaw * 0.5 - 3000;

  const outputVoltageRaw = b.readUInt16LE(2);
  const outputVoltageV = outputVoltageRaw * 0.1;

  const outputCurrentRaw = b.readUInt16LE(4);
  const outputCurrentA = outputCurrentRaw * 0.1;

  const torqueRaw = b.readUInt16LE(6);
  const motorTorqueNm = torqueRaw * 1.0;

  return {
    raw: [...b],

    speedRaw,
    motorSpeedRpm,

    outputVoltageRaw,
    outputVoltageV,

    outputCurrentRaw,
    outputCurrentA,

    torqueRaw,
    motorTorqueNm,
  };
};

module.exports = { parseAirPumpStatus1, parseAirPumpStatus2 };
