// raw-can-trial/decoders/motor.js
// Motor controller frames 0xC08A6A7 / 0xC09A6A7 / 0xC0AA6A7 (Intel), ported
// as-is from the app.

// 0xC08A6A7
const parseMsg411 = (buffer) => {
  if (buffer.length < 8) return { error: 'Invalid Msg411 Data' };

  return {
    N_motorTorqueLim: buffer.readUInt16LE(0) - 15000,
    N_motorTorque: buffer.readUInt16LE(2) - 15000,
    N_motorSpeed: buffer.readUInt16LE(4) - 15000,
    St_motorDirection: buffer[6] & 0x03,
    St_motorMode: (buffer[6] >> 2) & 0x03,
    St_motor: (buffer[6] >> 4) & 0x03,
    St_MCU_enable: (buffer[6] >> 6) & 0x01,
    St_MCUdriverPermit: buffer[7] & 0x01,
    St_MCUoffPermit: (buffer[7] >> 1) & 0x01,
  };
};

// 0xC09A6A7
const parseMsg412 = (buffer) => {
  if (buffer.length < 8) return { error: 'Invalid Msg412 Data' };

  return {
    N_MotorACCurrent: buffer.readUInt16LE(0) * 0.1,
    N_MotorACVoltage: buffer.readUInt16LE(2) * 0.1,
    N_MCUDCVoltage: buffer.readUInt16LE(4) * 0.1,
    N_motorTemp: buffer[6] - 40,
    N_MCUTemp: buffer[7] - 40,
  };
};

// 0xC0AA6A7
const parseMsg413 = (buffer) => {
  if (buffer.length < 8) return { error: 'Invalid Msg413 Data' };

  return {
    hardwareDriverFailure: buffer[0] & 0x01,
    hardwareOvercurrentFault: (buffer[0] >> 1) & 0x01,
    zeroOffsetFault: (buffer[0] >> 2) & 0x01,
    fanFailure: (buffer[0] >> 3) & 0x01,
    temperatureDifferenceFailure: (buffer[0] >> 4) & 0x01,
    acHallFailure: (buffer[0] >> 5) & 0x01,
    stallFailure: (buffer[0] >> 6) & 0x01,
    lowVoltageUndervoltageFault: (buffer[0] >> 7) & 0x01,
    softwareOvercurrentFault: buffer[1] & 0x01,
    hardwareOvervoltageFault: (buffer[1] >> 1) & 0x01,
    totalHardwareFailure: (buffer[1] >> 2) & 0x01,
    busOvervoltageFault: (buffer[1] >> 3) & 0x01,
    busbarUndervoltageFault: (buffer[1] >> 4) & 0x01,
    moduleOverTemperatureFault: (buffer[1] >> 5) & 0x01,
    moduleOverTemperatureWarning: (buffer[1] >> 6) & 0x01,
    overspeedFault: (buffer[1] >> 7) & 0x01,
    overRpmAlarmFlag: buffer[2] & 0x01,
    motorOverTemperatureWarning: (buffer[2] >> 1) & 0x01,
    motorOverTemperatureFault: (buffer[2] >> 2) & 0x01,
    canOfflineFailure: (buffer[2] >> 3) & 0x01,
    encoderFailure: (buffer[2] >> 4) & 0x01,
    radTemp: buffer[3] - 40,
    motorQuantity: buffer[6] & 0x0f,
    motorNum: (buffer[6] >> 4) & 0x0f,
    mcuNumber: buffer[7],
  };
};

module.exports = { parseMsg411, parseMsg412, parseMsg413 };
