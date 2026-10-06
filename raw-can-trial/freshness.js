// raw-can-trial/freshness.js
// How long a frame's values stay "fresh" after it was last received, per
// freshness key. Copied from FRESH_MS in the app's BatteryBluetoothProvider.tsx
// (commit d76659a): every key is 300 s there, so it is here too.

const FRESH_MS = Object.freeze({
  motor411: 300_000,
  motor412: 300_000,
  motor413: 300_000,
  vcu140: 300_000,
  bms1: 300_000,
  bms2: 300_000,
  bms3: 300_000,
  bms4: 300_000,
  bms5: 300_000,
  bms7: 300_000,
  bms8: 300_000,
  bms9: 300_000,
  bms10: 300_000,
  bms11: 300_000,
  bms12: 300_000,
  imd: 300_000,
  dcdcStatus1: 300_000,
  dcdcStatus2: 300_000,
  btmsStatus: 300_000,
  btmsCmd: 300_000,
  evcc1Control: 300_000,
  evcc1EvseLimits: 300_000,
  evcc1EvseStatus2: 300_000,
  air1: 300_000,
  air2: 300_000,
  gpio: 300_000, // GPIO is not a CAN frame, so it is never fresh in the trial
});

const FRESH_KEYS = Object.freeze(Object.keys(FRESH_MS));

/** Longest freshness window: how far back state can depend on old frames. */
const MAX_FRESH_MS = Math.max(...Object.values(FRESH_MS));

module.exports = { FRESH_MS, FRESH_KEYS, MAX_FRESH_MS };
