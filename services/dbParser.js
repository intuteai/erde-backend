// services/dbParser.js
const db = require('../config/postgres');
const logger = require('../utils/logger');

const cache = new Map(); // vehicle_master_id → mapping

const getMapping = async (vehicleMasterId) => {
  if (cache.has(vehicleMasterId)) return cache.get(vehicleMasterId);

  const res = await db.query(
    `SELECT can_id, parameter, byte_offset, bit_length, scale, value_offset, signed
     FROM vehicle_can_signals WHERE vehicle_master_id = $1`,
    [vehicleMasterId]
  );

  const map = {};
  res.rows.forEach(r => {
    map[r.can_id] = {
      param: r.parameter.toLowerCase().replace(/ /g, '_'),
      offset: r.byte_offset || 0,
      len: r.bit_length || 16,
      scale: parseFloat(r.scale) || 1,
      add: parseFloat(r.value_offset) || 0,
      signed: r.signed
    };
  });

  cache.set(vehicleMasterId, map);
  return map;
};

const parseCanDataWithDB = async (hex, vehicleMasterId) => {
  const map = await getMapping(vehicleMasterId);
  const buf = Buffer.from(hex, 'hex');
  const out = { timestamp: Date.now() };

  for (const [canId, sig] of Object.entries(map)) {
    if (!hex.startsWith(canId.replace('x', ''))) continue;

    const bytes = buf.slice(sig.offset, sig.offset + Math.ceil(sig.len / 8));
    let raw = 0;
    for (let i = 0; i < bytes.length; i++) raw = (raw << 8) | bytes[i];

    if (sig.signed && (raw & (1 << (sig.len - 1)))) {
      raw -= (1 << sig.len);
    }

    const value = raw * sig.scale + sig.add;
    out[sig.param] = parseFloat(value.toFixed(3));
  }

  return out;
};

module.exports = { parseCanDataWithDB };