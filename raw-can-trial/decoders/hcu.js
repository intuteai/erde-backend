// raw-can-trial/decoders/hcu.js
// HCU_Command_P 0x142CFF27 (Intel), ported as-is from the app.

const parseHcuCommandP = (buffer) => {
  if (buffer.length < 8) return { error: 'HCU_Command_P too short' };

  const enableCmd = buffer.readUInt8(0);
  const vSetRaw = buffer.readUInt16LE(1);
  const iLimitRaw = buffer.readUInt16LE(3);
  const enable =
    enableCmd === 0xaa ? 'start' :
    enableCmd === 0x55 ? 'stop' :
    'unknown';

  return {
    raw: [...buffer],
    enableCmd,
    enable,
    vSetRaw,
    vSetV: vSetRaw * 0.1,
    iLimitRaw,
    iLimitA: iLimitRaw * 0.1,
  };
};

module.exports = { parseHcuCommandP };
