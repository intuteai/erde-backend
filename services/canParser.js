const logger = require('../utils/logger');

const parseCanData = (payload, config) => {
  if (!config) {
    logger.error('Configuration is missing in parseCanData');
    throw new Error('Configuration is missing');
  }
  const now = Date.now();
  const battery = {};
  const motor = {};
  const faults = {};
  const metadata = {};

  // Handle single payload or array
  const payloads = Array.isArray(payload) ? payload : [payload];
  const latestPayload = payloads[payloads.length - 1] || {};

  // Battery parsing
  const socId = config.canMappings.battery.soc;
  battery.soc = latestPayload[socId]?.soc ? (latestPayload[socId].soc / 100).toFixed(2) : '0.00';
  battery.stackVoltage = latestPayload[socId]?.stackVoltage ?? 'N/A';
  battery.batteryStatus = latestPayload[config.canMappings.battery.batteryStatus]?.packState ?? 'OFF';
  battery.maxVoltage = latestPayload[config.canMappings.battery.maxVoltage]?.vmax ?? 'N/A';
  battery.minVoltage = latestPayload[config.canMappings.battery.minVoltage]?.vmin ?? 'N/A';
  battery.avgVoltage = latestPayload[config.canMappings.battery.avgVoltage]?.vavg ?? 'N/A';
  battery.maxTemp = latestPayload[config.canMappings.battery.maxTemp]?.tempMax ?? 'N/A';
  battery.minTemp = latestPayload[config.canMappings.battery.minTemp]?.tempMin ?? 'N/A';
  battery.avgTemp = latestPayload[config.canMappings.battery.avgTemp]?.tempAvg ?? 'N/A';
  battery.current = latestPayload[config.canMappings.battery.current]?.current ?? '0';
  battery.chargerCurrentDemand = latestPayload[config.canMappings.battery.chargerCurrentDemand]?.chargeCurrentDemand ?? '0';
  battery.chargerVoltageDemand = latestPayload[config.canMappings.battery.chargerVoltageDemand]?.constantVoltageDemand ?? '0';

  // Module Temps
  Object.keys(config.canMappings.battery.moduleTemps).forEach(module => {
    const ids = config.canMappings.battery.moduleTemps[module];
    const temps = ids.map(id => latestPayload[id]?.temperatures || []).flat();
    battery[`${module}Temps`] = temps.length ? temps.join(', ') + ' °C' : 'N/A';
  });

  // Cell Voltages
  Object.keys(config.canMappings.battery.cellVoltages).forEach(module => {
    const ids = config.canMappings.battery.cellVoltages[module];
    const voltages = ids.map(id => latestPayload[id]?.cellVoltages || []).flat();
    battery[`${module}CellsAvg`] = voltages.length ? (voltages.reduce((a, b) => a + b, 0) / voltages.length).toFixed(2) + ' V' : 'N/A';
  });

  // Motor parsing
  const torqueId = config.canMappings.motor.torqueLimit;
  motor.torqueLimit = latestPayload[torqueId]?.N_motorTorqueLim ?? 'N/A';
  motor.torqueValue = latestPayload[torqueId]?.N_motorTorque ?? 'N/A';
  motor.motorSpeed = latestPayload[torqueId]?.N_motorSpeed ?? 'N/A';
  motor.rotationDirection = latestPayload[torqueId]?.St_motorDirection ? 'Forward' : 'Reverse';
  motor.operationMode = latestPayload[torqueId]?.St_motorMode ?? 'N/A';
  motor.mcuEnable = latestPayload[torqueId]?.St_MCU_enable ? 'Enabled' : 'Disabled';
  motor.mcuDrivePermit = latestPayload[torqueId]?.St_MCUdriverPermit ? 'Permitted' : 'Not Permitted';
  motor.mcuOffPermit = latestPayload[torqueId]?.St_MCUoffPermit ? 'Permitted' : 'Not Permitted';
  motor.acCurrent = latestPayload[config.canMappings.motor.acCurrent]?.N_MotorACCurrent ?? 'N/A';
  motor.acVoltage = latestPayload[config.canMappings.motor.acVoltage]?.N_MotorACVoltage ?? 'N/A';
  motor.dcVoltage = latestPayload[config.canMappings.motor.dcVoltage]?.N_MCUDCVoltage ?? 'N/A';
  motor.motorTemp = latestPayload[config.canMappings.motor.motorTemp]?.N_motorTemp ?? 'N/A';
  motor.mcuTemp = latestPayload[config.canMappings.motor.mcuTemp]?.N_MCUTemp ?? 'N/A';
  motor.totalFaultStatus = latestPayload[config.canMappings.motor.totalFaultStatus]?.totalHardwareFailure ? 'Active' : 'Inactive';

  // Metadata
  metadata.radiatorTemp = latestPayload[config.canMappings.metadata.radiatorTemp]?.radTemp ?? 'N/A';
  metadata.motorQuantity = latestPayload[config.canMappings.metadata.motorQuantity]?.motorQuantity ?? 'N/A';
  metadata.motorNum = latestPayload[config.canMappings.metadata.motorNum]?.motorNum ?? 'N/A';
  metadata.mcuManufacturer = latestPayload[config.canMappings.metadata.mcuManufacturer]?.mcuNumber ?? 'N/A';

  // Faults
  const faultsBase = config.canMappings.faults.baseId;
  config.canMappings.faults.keys.forEach(key => {
    const value = latestPayload[faultsBase]?.[key];
    faults[key] = value ? 'Active' : 'Inactive';
  });

  return { battery, motor, faults, metadata, timestamp: now };
};

module.exports = { parseCanData };