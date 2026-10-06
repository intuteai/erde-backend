// raw-can-trial/config.js
// Trial settings, read from the environment on every call so a restart is the
// only thing needed to change them.

/** Kill switch: the route works only when RAW_CAN_ENABLED is exactly "true". */
const isEnabled = () => process.env.RAW_CAN_ENABLED === 'true';

/** Test-only key for the raw route. Empty means every request is rejected. */
const apiKey = () => process.env.RAW_CAN_API_KEY || '';

/**
 * Vehicle/device pairs allowed to send, from RAW_CAN_ALLOWED_PAIRS,
 * e.g. "2:VCL001,3:VCL003". Returns a Set of "vehicleMasterId:deviceId".
 */
const allowedPairs = () => {
  const pairs = new Set();
  for (const entry of (process.env.RAW_CAN_ALLOWED_PAIRS || '').split(',')) {
    const match = entry.trim().match(/^([1-9]\d*):(\S+)$/);
    if (match) pairs.add(`${match[1]}:${match[2]}`);
  }
  return pairs;
};

module.exports = { isEnabled, apiKey, allowedPairs };
