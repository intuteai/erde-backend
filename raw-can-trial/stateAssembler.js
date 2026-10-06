// raw-can-trial/stateAssembler.js
// Rebuilds, from raw frames, the state the app holds and the snapshot it uploads.
// Merging and freshness copy BatteryBluetoothProvider.tsx (commit d76659a), so
// any difference against live_values points at transport or porting problems.
const { decodeFrame } = require('./decoders');
const { buildLiveValues } = require('./buildLiveValues');
const { FRESH_MS, FRESH_KEYS } = require('./freshness');

const SNAPSHOT_INTERVAL_MS = 2000; // the app uploads one snapshot every 2 s

/** The app's setData merge for one decoded frame (rawFrame and device_id omitted). */
const mergeDecoded = (prev, d) => ({
  ...prev,
  ...d,
  motorBasic: { ...(prev.motorBasic || {}), ...(d.motorBasic || {}) },
  motorExtended: { ...(prev.motorExtended || {}), ...(d.motorExtended || {}) },
  dcdcVtgCur: { ...(prev.dcdcVtgCur || {}), ...(d.dcdcVtgCur || {}) },
  dcdcStatus1: { ...(prev.dcdcStatus1 || {}), ...(d.dcdcStatus1 || {}) },
  dcdcStatus2: { ...(prev.dcdcStatus2 || {}), ...(d.dcdcStatus2 || {}) },
  btmsStatus: { ...(prev.btmsStatus || {}), ...(d.btmsStatus || {}) },
  btmsCommand: { ...(prev.btmsCommand || {}), ...(d.btmsCommand || {}) },
  evcc: {
    ...(prev.evcc || {}),
    ...(d.evcc || {}),
    control: { ...(prev.evcc?.control || {}), ...(d.evcc?.control || {}) },
    evseLimits: { ...(prev.evcc?.evseLimits || {}), ...(d.evcc?.evseLimits || {}) },
    evseStatus2: { ...(prev.evcc?.evseStatus2 || {}), ...(d.evcc?.evseStatus2 || {}) },
  },
  airPumpStatus1: { ...(prev.airPumpStatus1 || {}), ...(d.airPumpStatus1 || {}) },
  airPumpStatus2: { ...(prev.airPumpStatus2 || {}), ...(d.airPumpStatus2 || {}) },
});

class StateAssembler {
  /** @param {{ evccFixed?: boolean }} opts evccFixed: decode EVCC as app builds with the EVCC fix do */
  constructor({ evccFixed = false } = {}) {
    this.decodeOpts = { bigInt: evccFixed };
    this.reset();
  }

  /** New session: the app starts from empty state after a reconnect or restart. */
  reset() {
    this.data = {};
    this.lastSeen = Object.fromEntries(FRESH_KEYS.map((k) => [k, 0]));
    this.lastFrameAtMs = null;
  }

  /**
   * Applies one frame. Returns false for CAN ids the app does not decode.
   * @param {{ canId: number, payload: Buffer, receivedAtMs: number }} frame
   */
  apply(frame) {
    this.lastFrameAtMs = frame.receivedAtMs;
    const decoded = decodeFrame(frame.canId, frame.payload, this.decodeOpts);
    if (!decoded) return false;
    if (decoded.freshKey) this.lastSeen[decoded.freshKey] = frame.receivedAtMs;
    this.data = mergeDecoded(this.data, decoded.partial);
    return true;
  }

  freshAt(atMs) {
    const fresh = {};
    for (const k of FRESH_KEYS) fresh[k] = atMs - this.lastSeen[k] < FRESH_MS[k];
    return fresh;
  }

  /** The live object the app would upload at this moment. */
  snapshot(atMs) {
    return buildLiveValues(this.data, { fresh: this.freshAt(atMs) });
  }
}

/** Converts a stored frame (contract JSON) into the assembler's input. */
const toFrame = (f) => ({
  sequence: Number(f.sequence),
  receivedAtMs: Number(f.receivedAtMs),
  canId: Number(f.canId),
  payload: Buffer.from(f.dataBase64, 'base64'),
});

/**
 * Groups stored batches into sessions, orders frames by sequence and drops
 * frames seen more than once. Sessions are ordered by their first frame.
 *
 * @param {Array<{ session_id: string, frames: object[] }>} batches
 * @returns {{ sessions: Array<{ sessionId: string, frames: object[] }>, duplicateFrames: number }}
 */
const orderSessions = (batches) => {
  const bySession = new Map();
  for (const b of batches) {
    if (!bySession.has(b.session_id)) bySession.set(b.session_id, new Map());
    const seen = bySession.get(b.session_id);
    for (const f of b.frames) {
      const frame = toFrame(f);
      seen.set(frame.sequence, (seen.get(frame.sequence) || { frame, count: 0 }));
      seen.get(frame.sequence).count += 1;
    }
  }

  let duplicateFrames = 0;
  const sessions = [];
  for (const [sessionId, seen] of bySession) {
    const frames = [];
    for (const { frame, count } of seen.values()) {
      frames.push(frame);
      duplicateFrames += count - 1;
    }
    frames.sort((a, b) => a.sequence - b.sequence);
    sessions.push({ sessionId, frames });
  }
  sessions.sort((a, b) => a.frames[0].receivedAtMs - b.frames[0].receivedAtMs);
  return { sessions, duplicateFrames };
};

/**
 * The trial's shadow stream: one snapshot at the end of every 2-second window
 * (tablet time) in which at least one frame arrived, per session.
 *
 * @returns {Array<{ recordedAtMs: number, sessionId: string, lastSequence: number, live: object }>}
 */
const buildShadowSnapshots = (sessions, opts = {}) => {
  const out = [];
  const asm = new StateAssembler(opts);

  for (const { sessionId, frames } of sessions) {
    asm.reset();
    let windowEnd = null;
    let lastSequence = null;

    const emit = () => out.push({
      recordedAtMs: windowEnd,
      sessionId,
      lastSequence,
      live: asm.snapshot(windowEnd),
    });

    for (const frame of frames) {
      if (windowEnd !== null && frame.receivedAtMs >= windowEnd) {
        emit();
        windowEnd = null;
      }
      if (windowEnd === null) {
        windowEnd = (Math.floor(frame.receivedAtMs / SNAPSHOT_INTERVAL_MS) + 1) * SNAPSHOT_INTERVAL_MS;
      }
      asm.apply(frame);
      lastSequence = frame.sequence;
    }
    if (windowEnd !== null) emit();
  }
  return out;
};

/**
 * State at given moments, for comparing with the app's uploads. Each moment
 * uses the latest session that had started by then.
 *
 * @param {Array} sessions   from orderSessions()
 * @param {number[]} times   ascending, tablet epoch ms
 * @returns {Array<{ atMs: number, live: object|null, lastFrameAtMs: number|null }>}
 *          live is null when no session had started yet
 */
const snapshotsAt = (sessions, times, opts = {}) => {
  const out = [];
  const asm = new StateAssembler(opts);
  let s = -1;
  let i = 0;

  for (const t of times) {
    // Move to the latest session whose first frame is at or before t.
    while (s + 1 < sessions.length && sessions[s + 1].frames[0].receivedAtMs <= t) {
      s += 1;
      i = 0;
      asm.reset();
    }
    if (s < 0) {
      out.push({ atMs: t, live: null, lastFrameAtMs: null });
      continue;
    }
    const { frames } = sessions[s];
    while (i < frames.length && frames[i].receivedAtMs <= t) asm.apply(frames[i++]);
    out.push({ atMs: t, live: asm.snapshot(t), lastFrameAtMs: asm.lastFrameAtMs });
  }
  return out;
};

module.exports = {
  StateAssembler,
  mergeDecoded,
  orderSessions,
  buildShadowSnapshots,
  snapshotsAt,
  SNAPSHOT_INTERVAL_MS,
};
