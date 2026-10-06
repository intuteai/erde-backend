// raw-can-trial/decoders/index.js
// CAN id -> decoder map, mirroring the app's parseBluetoothData switch.
// decodeFrame returns { freshKey, partial } where partial is what the app's
// case returns minus rawFrame, and freshKey is the lastSeenRef key it updates.

const bms = require('./bms');
const { parseVcuContactorState } = require('./vcu');
const { parseImd } = require('./imd');
const { parseDcdcStatus1, parseDcdcStatus2 } = require('./dcdc');
const { parseHcuCommandP } = require('./hcu');
const { parseBtmsCommand, parseBtmsStatus } = require('./btms');
const { parseAirPumpStatus1, parseAirPumpStatus2 } = require('./airPump');
const { parseEvcc510Like, parseEvcc511Like, parseEvcc512Like } = require('./evcc');
const { parseMsg411, parseMsg412, parseMsg413 } = require('./motor');

// Keys are the app's id strings: "0x" + uppercase hex, no zero padding.
const CASES = {
  '0x140': ['vcu140', (p) => ({ vcuContactorState: parseVcuContactorState(p) })],
  '0x141': ['bms1', (p) => ({ bms1: bms.parseBms1(p) })],
  '0x142': ['bms2', (p) => ({ bms2: bms.parseBms2(p) })],
  '0x143': ['bms3', (p) => ({ bms3: bms.parseBms3(p) })],
  '0x144': ['bms4', (p) => ({ bms4: bms.parseBms4(p) })],
  '0x145': ['bms5', (p) => ({ bms5: bms.parseBms5(p) })],
  '0x146': [null, (p) => ({ bms6: bms.parseBms6(p) })],
  '0x147': ['bms7', (p) => ({ bms7: bms.parseBms7(p) })],
  '0x148': ['bms8', (p) => ({ bms8Faults: bms.parseBms8Faults(p) })],
  '0x149': ['bms9', (p) => ({ bms9Energy: bms.parseBms9Energy(p) })],
  '0x150': ['bms10', (p) => ({ bms10Currents: bms.parseBms10Currents(p) })],
  '0x151': ['bms11', (p) => ({ bms11StringVoltages: bms.parseBms11StringVoltages(p) })],
  '0x152': ['bms12', (p) => ({ bms12StringVoltages: bms.parseBms12StringVoltages(p) })],
  '0x153': [null, (p) => ({ bms13SocStrings: bms.parseBms13SocStrings(p) })],
  '0x154': [null, (p) => ({ bms14Ah: bms.parseBms14Ah(p) })],

  '0x1819A1A4': ['imd', (p) => ({ imd: parseImd(p) })],

  // On a short frame status1/status2 is an error object, so the dcdcVtgCur
  // values come out undefined, as in the app.
  '0x1800D08F': ['dcdcStatus1', (p) => {
    const status1 = parseDcdcStatus1(p);
    return {
      dcdcStatus1: status1,
      dcdcVtgCur: {
        Input_Voltage: status1.inputVoltageV,
        Input_Current: status1.inputCurrentA,
      },
    };
  }],
  '0x1801D08F': ['dcdcStatus2', (p) => {
    const status2 = parseDcdcStatus2(p);
    return {
      dcdcStatus2: status2,
      dcdcVtgCur: {
        Output_Voltage: status2.outputVoltageV,
        Output_Current: status2.outputCurrentA,
      },
    };
  }],

  '0x142CFF27': [null, (p) => ({ hcuCommandP: parseHcuCommandP(p) })],

  '0x18FFC13A': ['btmsStatus', (p) => ({ btmsStatus: parseBtmsStatus(p) })],
  '0x18FF45F4': ['btmsCmd', (p) => ({ btmsCommand: parseBtmsCommand(p) })],

  '0x18FF1BA6': ['air1', (p) => ({ airPumpStatus1: parseAirPumpStatus1(p) })],
  '0x18FF1CA6': ['air2', (p) => ({ airPumpStatus2: parseAirPumpStatus2(p) })],

  '0x1011F456': ['evcc1Control', (p, o) => ({ evcc: { control: parseEvcc510Like(p, o) } })],
  '0x1819F456': ['evcc1EvseLimits', (p) => ({ evcc: { evseLimits: parseEvcc511Like(p) } })],
  '0x181DF456': ['evcc1EvseStatus2', (p, o) => ({ evcc: { evseStatus2: parseEvcc512Like(p, o) } })],

  // On a short frame t is an error object: N_motorSpeed is undefined, so
  // running is true and statusLabel "Running", as in the app.
  '0xC08A6A7': ['motor411', (p) => {
    const t = parseMsg411(p);
    return {
      message411: t,
      motorBasic: {
        torqueRaw: t.N_motorTorque,
        rpm: t.N_motorSpeed,
        statusWord: t.St_motor,
        running: t.N_motorSpeed !== 0,
        direction:
          t.St_motorDirection === 1 ? 'forward' :
          t.St_motorDirection === 2 ? 'reverse' :
          'stopped',
        statusLabel: t.N_motorSpeed !== 0 ? 'Running' : 'Stopped',
        hasFault: false,
        hasWarning: false,
      },
    };
  }],
  '0xC09A6A7': ['motor412', (p) => {
    const t = parseMsg412(p);
    return {
      message412: t,
      motorBasic: {
        currentRaw: t.N_MotorACCurrent,
        vOutRaw: t.N_MotorACVoltage,
        dcBusRaw: t.N_MCUDCVoltage,
        igbtTempC: t.N_MCUTemp,
        motorTempC: t.N_motorTemp,
      },
    };
  }],
  '0xC0AA6A7': ['motor413', (p) => {
    const t = parseMsg413(p);
    return {
      message413: t,
      motorBasic: {
        hasFault:
          Boolean(t.hardwareDriverFailure) ||
          Boolean(t.hardwareOvercurrentFault) ||
          Boolean(t.softwareOvercurrentFault) ||
          Boolean(t.hardwareOvervoltageFault) ||
          Boolean(t.busOvervoltageFault) ||
          Boolean(t.busbarUndervoltageFault) ||
          Boolean(t.moduleOverTemperatureFault) ||
          Boolean(t.overspeedFault) ||
          Boolean(t.motorOverTemperatureFault) ||
          Boolean(t.canOfflineFailure) ||
          Boolean(t.encoderFailure),
        hasWarning:
          Boolean(t.moduleOverTemperatureWarning) ||
          Boolean(t.motorOverTemperatureWarning),
        radTemp: t.radTemp,
      },
    };
  }],
};

const KNOWN_CAN_IDS = Object.keys(CASES).map((id) => parseInt(id, 16));

const canIdString = (canId) => '0x' + (canId >>> 0).toString(16).toUpperCase();

/**
 * Decode one CAN frame the way the app does.
 * Returns null for ids the app does not know. If a parser throws, the app's
 * outer catch yields { parsingError } after the freshness key was already set
 * (this is what full-length EVCC 510/512 frames do in the app, see evcc.js).
 * opts.bigInt = true decodes those EVCC frames instead.
 */
const decodeFrame = (canId, payload, opts = {}) => {
  const id = canIdString(canId);
  if (!Object.prototype.hasOwnProperty.call(CASES, id)) return null;
  const entry = CASES[id];

  const [freshKey, build] = entry;
  try {
    return { freshKey, partial: build(payload, opts) };
  } catch (error) {
    return { freshKey, partial: { parsingError: error.message } };
  }
};

module.exports = { decodeFrame, KNOWN_CAN_IDS, canIdString };
