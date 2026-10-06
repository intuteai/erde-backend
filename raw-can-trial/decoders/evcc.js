// raw-can-trial/decoders/evcc.js
// EVCC frames 0x1011F456 / 0x1819F456 / 0x181DF456 (Intel), ported as-is from the app.
//
// The app imports Buffer from the npm "buffer" package, which its lockfile
// pins at 5.7.1. That version has no readBigUInt64LE, so in the app the 510
// and 512 parsers throw on every full-length frame and parseBluetoothData's
// catch returns { parsingError }. By default we throw the same way. Pass
// { bigInt: true } to get the decode the app code intends instead.

const APP_BIGINT_ERROR = 'buf.readBigUInt64LE is not a function (it is undefined)';

/** Little-endian 64-bit bit reader, same as the app's inline getBits. */
const bitReader = (buf, opts) => {
  if (!(opts && opts.bigInt)) throw new TypeError(APP_BIGINT_ERROR);
  const frame = buf.readBigUInt64LE(0);
  return (start, length) => {
    const mask = (1n << BigInt(length)) - 1n;
    return Number((frame >> BigInt(start)) & mask);
  };
};

// 0x1011F456 (0x510-like)
const parseEvcc510Like = (buf, opts) => {
  if (buf.length < 8) return { error: 'EVCC 0x510-like frame too short' };

  const getBits = bitReader(buf, opts);

  return {
    raw: [...buf],

    EVCC_PwrStat: getBits(0, 1),
    EVCC_SocketStat: getBits(1, 1),
    Evse_Stat: getBits(2, 4),
    Evse_ChgFinished: getBits(6, 1),
    Evse_Processing: getBits(7, 1),

    Evse_IsolStat: getBits(8, 2),
    Evse_TransferType: getBits(10, 4),
    Evse_Notification: getBits(14, 2),

    Evse_PwrDelivery: getBits(16, 1),
    EVCC_ChgFinished: getBits(17, 1),
    EVCC_CPStat: getBits(18, 3),
    EVCC_S2_OnStat: getBits(21, 1),
    EVCC_PDStat: getBits(22, 2),

    EVCC_DutyValue: getBits(24, 7),
    EVCC_LockStat: getBits(31, 1),

    EVCC_AagValue: getBits(32, 8),
    EVCC_ErrorCode: getBits(40, 8),
    EVCC_StepNum: getBits(48, 8),
    Evse_MaxDelay: getBits(56, 8),
  };
};

// 0x1819F456 (0x511-like)
const parseEvcc511Like = (buf) => {
  if (buf.length < 8) return { error: 'EVCC 0x511-like frame too short' };

  return {
    raw: [...buf],

    Evse_MaxVolt_V: buf.readUInt16LE(0) * 0.1,
    Evse_MaxCurr_A: buf.readUInt16LE(2) * 0.1,
    Evse_OutVolt_V: buf.readUInt16LE(4) * 0.1,
    EVSE_OutCurr_A: buf.readUInt16LE(6) * 0.1,
  };
};

// 0x181DF456 (0x512-like)
const parseEvcc512Like = (buf, opts) => {
  if (buf.length < 8) return { error: 'EVCC 0x512-like frame too short' };

  const getBits = bitReader(buf, opts);

  return {
    raw: [...buf],

    Evse_MinVolt_V: getBits(0, 16) * 0.1,
    Evse_MinCurr_A: getBits(16, 16) * 0.1,
    Evse_MaxPwr_W: getBits(32, 16) * 10,

    EVCC_Lock_status: getBits(48, 2),
    EVCC_Lock_alarm: getBits(50, 2),
    Secc_DCAC_ChgMode: getBits(52, 2),

    EVSE_EVCC_ChgFinished: getBits(56, 1),
    Secc_ACMaxCurrentValue: getBits(57, 7),
  };
};

module.exports = { parseEvcc510Like, parseEvcc511Like, parseEvcc512Like, APP_BIGINT_ERROR };
