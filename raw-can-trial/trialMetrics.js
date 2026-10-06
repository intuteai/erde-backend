// raw-can-trial/trialMetrics.js
// Collects trial measurements window by window into one accumulator, so the
// same code serves a single-window report and a whole-trial comparison.
const db = require('../config/postgres');
const { loadBatches } = require('./rawData');
const { orderSessions, snapshotsAt } = require('./stateAssembler');
const { LIVE_KEYS } = require('./buildLiveValues');
const { KNOWN_CAN_IDS } = require('./decoders');
const {
  EXCLUDED_FIELDS, summarize, lossBySession, volumeFromCounts, ParityTally,
} = require('./analysis');
const { activeSegments } = require('./comparison');

/** App uploads are compared only if a raw frame arrived this recently before them. */
const RECENT_FRAME_MS = 2000;
/**
 * App uploads this soon after a sequence gap are not compared: the app may still
 * hold values from frames the raw path lost, so they would differ for a reason
 * that is loss, not decoding.
 */
const AFTER_LOSS_MS = 5000;

/** Receive times of the first frame after each sequence gap, ascending. */
const gapEndTimes = (sessions) => {
  const ends = [];
  for (const { frames } of sessions) {
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].sequence > frames[i - 1].sequence + 1) ends.push(frames[i].receivedAtMs);
    }
  }
  return ends.sort((a, b) => a - b);
};

/** live_values columns the comparison uses, with their types. */
const loadColumns = async () => {
  const res = await db.query(
    `SELECT column_name, data_type, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'live_values'`
  );
  const types = new Map(res.rows.map((r) => [r.column_name, { dataType: r.data_type, scale: r.numeric_scale }]));
  const columns = new Map();
  for (const key of LIVE_KEYS) {
    if (!EXCLUDED_FIELDS.includes(key) && types.has(key)) columns.set(key, types.get(key));
  }
  return columns;
};

const loadAppRows = async (vehicle, fromMs, toMs, columns) => {
  const list = [...columns.keys()].map((c) => `"${c}"`).join(', ');
  const res = await db.query(
    `SELECT (EXTRACT(EPOCH FROM recorded_at) * 1000)::float8 AS at_ms,
            pg_column_size(live_values.*) AS row_bytes, ${list}
     FROM live_values
     WHERE vehicle_master_id = $1
       AND recorded_at >= to_timestamp($2 / 1000.0)
       AND recorded_at <  to_timestamp($3 / 1000.0)
     ORDER BY recorded_at`,
    [vehicle, fromMs, toMs]
  );
  return res.rows;
};

/** Uncompressed size of the request body a stored batch was sent as. */
const requestBytes = (b) => Buffer.byteLength(JSON.stringify({
  schemaVersion: '1.0', vehicleMasterId: 0, deviceId: 'VCL000',
  sessionId: b.session_id, batchId: b.batch_id, sentAtMs: b.sent_at_ms,
  firstSequence: b.first_sequence, lastSequence: b.last_sequence, frames: b.frames,
}));

const createAccumulator = () => ({
  windows: 0,
  batches: 0,
  overlapBatches: 0,
  frames: 0,
  duplicateFrames: 0,
  storedBytes: 0,
  requestBytes: 0,
  loss: [],
  frameLag: [],
  batchTransit: [],
  batching: [],
  perId: new Map(),
  volumeFrames: 0,
  activeMs: 0,
  tally: new ParityTally(),
  appRows: 0,
  rowsCompared: 0,
  rowsWithoutRecentFrames: 0,
  rowsAfterLoss: 0,
  rowsBeforeFirstSession: 0,
  // old path (the app's decoded uploads), over the same windows
  old: {
    rowsInActive: 0,
    rowsOutsideActive: 0,
    expectedSlots: 0,
    gapsOver10s: 0,
    longestGapMs: 0,
    storedBytes: 0,
    uploadJsonBytes: 0,
    uploadsSized: 0,
  },
  segmentMs: 0,
});

/**
 * Adds one time window [fromMs, toMs) to the accumulator.
 * Batches are counted by server receive time; app rows by their tablet time.
 */
const collectWindow = async (acc, { vehicle, fromMs, toMs, evccFixed = false, columns }) => {
  const allBatches = await loadBatches(vehicle, fromMs, toMs);
  const appRows = await loadAppRows(vehicle, fromMs, toMs, columns);
  const inWindow = allBatches.filter((b) => b.server_ms >= fromMs && b.server_ms < toMs);
  const ordered = orderSessions(inWindow);
  acc.windows += 1;

  // ── new path: ingest, loss, timing, volume ──
  acc.batches += inWindow.length;
  acc.overlapBatches += inWindow.filter((b) => b.overlap).length;
  acc.frames += inWindow.reduce((n, b) => n + b.frame_count, 0);
  acc.duplicateFrames += ordered.duplicateFrames;
  for (const b of inWindow) {
    acc.storedBytes += Number(b.stored_bytes);
    acc.requestBytes += requestBytes(b);
    acc.batchTransit.push(b.server_ms - b.sent_at_ms);
    acc.batching.push(b.sent_at_ms - Number(b.frames[0].receivedAtMs));
    for (const f of b.frames) acc.frameLag.push(b.server_ms - Number(f.receivedAtMs));
  }
  acc.loss.push(...lossBySession(ordered.sessions));
  for (const s of ordered.sessions) {
    acc.activeMs += s.frames[s.frames.length - 1].receivedAtMs - s.frames[0].receivedAtMs;
    for (const f of s.frames) {
      acc.volumeFrames += 1;
      acc.perId.set(f.canId, (acc.perId.get(f.canId) || 0) + 1);
    }
  }

  // ── parity: rebuilt state at each app upload's tablet time ──
  const { sessions } = orderSessions(allBatches);
  const states = snapshotsAt(sessions, appRows.map((r) => r.at_ms), { evccFixed });
  const gapEnds = gapEndTimes(sessions);
  let g = 0;
  acc.appRows += appRows.length;
  states.forEach((state, i) => {
    if (!state.live) { acc.rowsBeforeFirstSession += 1; return; }
    if (state.lastFrameAtMs < state.atMs - RECENT_FRAME_MS) { acc.rowsWithoutRecentFrames += 1; return; }
    while (g < gapEnds.length && gapEnds[g] <= state.atMs - AFTER_LOSS_MS) g += 1;
    if (g < gapEnds.length && gapEnds[g] <= state.atMs) { acc.rowsAfterLoss += 1; return; }
    acc.rowsCompared += 1;
    acc.tally.addRow(state.atMs, appRows[i], state.live, columns);
    // Size of the app's upload for this row, rebuilt (same fields and values).
    acc.old.uploadJsonBytes += Buffer.byteLength(JSON.stringify({
      ts: Math.round(state.atMs), vehicleIdOrMasterId: vehicle, live: state.live, deviceId: 'VCL000',
    }));
    acc.old.uploadsSized += 1;
  });

  // ── old path: coverage while the vehicle was sending CAN data ──
  const segments = activeSegments(sessions, fromMs, toMs);
  let seg = 0;
  let prevInSegment = null;
  for (const row of appRows) {
    while (seg < segments.length && segments[seg].endMs < row.at_ms) { seg += 1; prevInSegment = null; }
    const inside = seg < segments.length && row.at_ms >= segments[seg].startMs;
    if (!inside) { acc.old.rowsOutsideActive += 1; continue; }
    acc.old.rowsInActive += 1;
    acc.old.storedBytes += Number(row.row_bytes); // per active hour, like the new path
    const gap = row.at_ms - (prevInSegment ?? segments[seg].startMs);
    if (gap > 10_000) acc.old.gapsOver10s += 1;
    acc.old.longestGapMs = Math.max(acc.old.longestGapMs, gap);
    prevInSegment = row.at_ms;
  }
  for (const s of segments) {
    acc.segmentMs += s.endMs - s.startMs;
    acc.old.expectedSlots += Math.floor((s.endMs - s.startMs) / 2000);
  }
};

/** The single-window report object rendered by analysis.renderMarkdown(). */
const toReport = (acc, { vehicle, fromMs, toMs, evccFixed, tableBytes }) => {
  const volume = volumeFromCounts(acc.perId, acc.volumeFrames, acc.activeMs, KNOWN_CAN_IDS);
  const activeHours = volume.activeSeconds / 3600;
  return {
    vehicle,
    fromMs,
    toMs,
    generatedAtMs: Date.now(),
    evccFixed,
    ingest: {
      batches: acc.batches,
      overlapBatches: acc.overlapBatches,
      frames: acc.frames,
      duplicateFrames: acc.duplicateFrames,
      batchesPerMinute: volume.activeSeconds > 0 ? acc.batches / (volume.activeSeconds / 60) : null,
      framesPerBatch: acc.batches ? volume.frames / acc.batches : null,
      storedBytes: acc.storedBytes,
      bytesPerActiveHour: activeHours > 0 ? acc.storedBytes / activeHours : null,
      tableBytes,
    },
    loss: acc.loss,
    timing: {
      frameLagMs: summarize(acc.frameLag),
      batchTransitMs: summarize(acc.batchTransit),
      batchingMs: summarize(acc.batching),
    },
    volume,
    parity: {
      appRows: acc.appRows,
      rowsCompared: acc.rowsCompared,
      rowsWithoutRecentFrames: acc.rowsWithoutRecentFrames,
      rowsAfterLoss: acc.rowsAfterLoss,
      rowsBeforeFirstSession: acc.rowsBeforeFirstSession,
      ...acc.tally.results(),
    },
  };
};

const tableBytes = async () =>
  (await db.query(`SELECT pg_total_relation_size('raw_can_batches')::float8 AS bytes`)).rows[0].bytes;

module.exports = {
  createAccumulator,
  collectWindow,
  toReport,
  loadColumns,
  tableBytes,
  RECENT_FRAME_MS,
  AFTER_LOSS_MS,
  gapEndTimes,
};
