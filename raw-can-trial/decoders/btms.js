// raw-can-trial/decoders/btms.js
// BTMS frames 0x18FF45F4 (BMS -> TMS) and 0x18FFC13A (TMS -> BMS), ported
// as-is from the app. The app's console.error on short frames is dropped.

// 0x18FF45F4. Voltage is read from bytes 1-2 (BE), as in the app.
const parseBtmsCommand = (buffer) => {
  if (buffer.length < 8) return { error: 'Invalid BTMS command frame' };

  const b0 = buffer[0];

  const reqModeRaw = b0 & 0x03;
  const hvReqRaw = (b0 >> 2) & 0x03;
  const chargeRaw = (b0 >> 4) & 0x03;
  const hvRelayRaw = (b0 >> 6) & 0x03;

  const mode =
    reqModeRaw === 0 ? 'shutdown' :
    reqModeRaw === 1 ? 'cooling' :
    reqModeRaw === 2 ? 'heating' :
    reqModeRaw === 3 ? 'self_circulation' :
    'invalid';

  const hvRequest =
    hvReqRaw === 0 ? 'hv_on_request' :
    hvReqRaw === 1 ? 'hv_off_request' :
    'invalid';

  const chargeStatus =
    chargeRaw === 0 ? 'not_charging' :
    chargeRaw === 1 ? 'charging' :
    'invalid';

  const bmsHvRelayState =
    hvRelayRaw === 0 ? 'open' :
    hvRelayRaw === 1 ? 'closed' :
    'invalid';

  const voltageRaw = buffer.readUInt16BE(1);
  const packVoltageV = voltageRaw === 0xffff ? null : voltageRaw;

  const tempSetRaw = buffer[4];
  const tempSetC = tempSetRaw === 0xff ? null : tempSetRaw - 40;

  const lifeCounter = buffer[6];
  const crc = buffer[7];

  return {
    raw: [...buffer],

    reqModeRaw,
    hvReqRaw,
    chargeRaw,
    hvRelayRaw,

    mode,
    hvRequest,
    chargeStatus,
    bmsHvRelayState,

    voltageRaw,
    packVoltageV,

    tempSetRaw,
    tempSetC,

    lifeCounter,
    crc,
  };
};

// 0x18FFC13A
const parseBtmsStatus = (buffer) => {
  if (buffer.length < 8) return { error: 'Invalid BTMS status frame' };

  const rawBytes = [...buffer];
  const b0 = buffer[0];

  const modeRaw = b0 & 0x03;
  const hvRelayRaw = (b0 >> 2) & 0x03;

  const tmsMode =
    modeRaw === 0 ? 'shutdown' :
    modeRaw === 1 ? 'cooling' :
    modeRaw === 2 ? 'heating' :
    modeRaw === 3 ? 'self_circulation' :
    'invalid';

  const hvRelayState =
    hvRelayRaw === 0 ? 'open' :
    hvRelayRaw === 1 ? 'closed' :
    'invalid';

  const decodeTempC = (raw) => (raw === 0xff ? null : raw - 40);

  const outletWaterTempC = decodeTempC(buffer[1]);
  const inletWaterTempC = decodeTempC(buffer[2]);

  const reserved4 = buffer[3];
  const reserved5 = buffer[4];

  const demandPowerRaw = buffer.readUInt16BE(5);
  const demandPowerKw = demandPowerRaw === 0xffff ? null : demandPowerRaw * 0.1;

  const b7 = buffer[7];
  const faultCode = b7 & 0x3f;
  const faultLevelRaw = (b7 >> 6) & 0x03;

  const faultLevel =
    faultLevelRaw === 0 ? 'none' :
    faultLevelRaw === 1 ? 'level1' :
    faultLevelRaw === 2 ? 'level2' :
    'invalid';

  return {
    raw: rawBytes,

    modeRaw,
    hvRelayRaw,
    tmsMode,
    hvRelayState,

    outletWaterTempC,
    inletWaterTempC,

    reserved4,
    reserved5,

    demandPowerRaw,
    demandPowerKw,

    faultCode,
    faultLevelRaw,
    faultLevel,
  };
};

module.exports = { parseBtmsCommand, parseBtmsStatus };
