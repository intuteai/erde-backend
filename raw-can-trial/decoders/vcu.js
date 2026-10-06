// raw-can-trial/decoders/vcu.js
// VCU contactor state 0x140, ported as-is from the app.

// 0x140. The app's comment says 2 = charging, but the code maps 3 to
// "charge_on" and 2 to "unknown". Kept as the code does it.
const parseVcuContactorState = (buf) => {
  if (buf.length < 1) return { error: '0x140 too short' };

  const raw = buf.readUInt8(0);

  const state =
    raw === 0 ? 'disabled' :
    raw === 1 ? 'discharge_on' :
    raw === 3 ? 'charge_on' :
    'unknown';

  return {
    CONTACTOR_STATE_RAW: raw,
    CONTACTOR_STATE: state,
  };
};

module.exports = { parseVcuContactorState };
