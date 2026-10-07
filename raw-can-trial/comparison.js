// raw-can-trial/comparison.js
// Old path (app decodes, uploads snapshots) vs new path (raw CAN, backend decodes):
// the pure parts of the whole-trial comparison. No database access here.
const { percentile } = require('./analysis');

/** Frames further apart than this split the vehicle's activity into separate segments. */
const SEGMENT_GAP_MS = 10_000;

/** Targets from the trial plan. */
const TARGETS = Object.freeze({
  maxMissingRate: 0.001, // "no unexplained sequence gaps"; 0.1% allows for a dropped connection or two
  maxLagP95Ms: 750,
  minParity: 0.999,
  minActiveHours: 10,
});

/**
 * Periods when the raw path saw CAN traffic: frames in [fromMs, toMs) no more
 * than 10 s apart form one segment. Used as "the vehicle was active".
 * @returns {Array<{ startMs: number, endMs: number }>} ascending, non-overlapping
 */
const activeSegments = (sessions, fromMs, toMs) => {
  const times = [];
  for (const s of sessions) {
    for (const f of s.frames) if (f.receivedAtMs >= fromMs && f.receivedAtMs < toMs) times.push(f.receivedAtMs);
  }
  times.sort((a, b) => a - b);
  const segments = [];
  for (const t of times) {
    const last = segments[segments.length - 1];
    if (last && t - last.endMs <= SEGMENT_GAP_MS) last.endMs = t;
    else segments.push({ startMs: t, endMs: t });
  }
  return segments.filter((s) => s.endMs > s.startMs);
};

const perHour = (value, hours) => (hours > 0 ? value / hours : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** Turns an accumulator from trialMetrics into the comparison object. */
const buildComparison = (acc, { vehicle, fromMs, toMs, evccFixed }) => {
  const activeHours = acc.segmentMs / 3_600_000;
  const expected = acc.loss.reduce((n, s) => n + s.expected, 0);
  const missing = acc.loss.reduce((n, s) => n + s.missing, 0);
  const lag = [...acc.frameLag].filter(Number.isFinite).sort((a, b) => a - b);
  const parity = acc.tally.results();
  const oldRows = acc.old.rowsInActive + acc.old.rowsOutsideActive;
  const avgUpload = ratio(acc.old.uploadJsonBytes, acc.old.uploadsSized);

  const c = {
    vehicle, fromMs, toMs, evccFixed, generatedAtMs: Date.now(),
    windows: acc.windows,
    activeHours,
    newPath: {
      framesExpected: expected,
      framesReceived: expected - missing,
      framesMissing: missing,
      missingRate: ratio(missing, expected),
      duplicateFrames: acc.duplicateFrames,
      overlapBatches: acc.overlapBatches,
      lagP50Ms: percentile(lag, 50),
      lagP95Ms: percentile(lag, 95),
      framesPerSecond: ratio(acc.volumeFrames, acc.segmentMs / 1000), // same active time as the old path
      storedBytesPerHour: perHour(acc.storedBytes, activeHours),
      requestBytesPerHour: perHour(acc.requestBytes, activeHours),
    },
    oldPath: {
      uploads: oldRows,
      uploadsWhileActive: acc.old.rowsInActive,
      expectedSlots: acc.old.expectedSlots,
      coverage: acc.old.expectedSlots ? Math.min(1, acc.old.rowsInActive / acc.old.expectedSlots) : null,
      gapsOver10s: acc.old.gapsOver10s,
      longestGapMs: acc.old.longestGapMs || null,
      uploadsWithoutRecentFrames: acc.rowsWithoutRecentFrames,
      uploadsOutsideActive: acc.old.rowsOutsideActive,
      uploadsPerSecond: ratio(acc.old.rowsInActive, acc.segmentMs / 1000),
      storedBytesPerHour: perHour(acc.old.storedBytes, activeHours),
      requestBytesPerHour: avgUpload === null ? null : perHour(avgUpload * acc.old.rowsInActive, activeHours),
    },
    parity: {
      rowsCompared: acc.rowsCompared,
      rowsAfterLoss: acc.rowsAfterLoss || 0,
      exactMatchRate: acc.tallyExact ? acc.tallyExact.results().matchRate : null,
      compared: parity.compared,
      matchRate: parity.matchRate,
      worstFields: parity.fields.filter((f) => f.compared > 0 && f.mismatches > 0).slice(0, 10),
    },
  };
  c.targets = evaluateTargets(c);
  c.verdict = verdict(c);
  return c;
};

/** Each trial target with its measured value and pass/fail (null when not measurable yet). */
const evaluateTargets = (c) => [
  {
    name: 'Trial coverage',
    target: `≥ ${TARGETS.minActiveHours} active hours`,
    value: c.activeHours,
    unit: 'h',
    pass: c.activeHours >= TARGETS.minActiveHours,
  },
  {
    name: 'Frames lost (new path)',
    target: `≤ ${(TARGETS.maxMissingRate * 100).toFixed(1)}%`,
    value: c.newPath.missingRate,
    unit: '%',
    pass: c.newPath.missingRate === null ? null : c.newPath.missingRate <= TARGETS.maxMissingRate,
  },
  {
    name: 'Tablet → server delay p95 (new path)',
    target: `≤ ${TARGETS.maxLagP95Ms} ms`,
    value: c.newPath.lagP95Ms,
    unit: 'ms',
    pass: c.newPath.lagP95Ms === null ? null : c.newPath.lagP95Ms <= TARGETS.maxLagP95Ms,
  },
  {
    name: 'Decoding parity with the app',
    target: `≥ ${(TARGETS.minParity * 100).toFixed(1)}%`,
    value: c.parity.matchRate,
    unit: '%',
    pass: c.parity.matchRate === null ? null : c.parity.matchRate >= TARGETS.minParity,
  },
];

/** A data-driven suggestion; the decision stays with the team. */
const verdict = (c) => {
  const byName = Object.fromEntries(c.targets.map((t) => [t.name, t]));
  const failed = c.targets.filter((t) => t.pass === false && t.name !== 'Trial coverage').map((t) => t.name);
  const unknown = c.targets.filter((t) => t.pass === null).map((t) => t.name);

  if (byName['Trial coverage'].pass === false) {
    return {
      decision: 'Not enough data yet',
      reasons: [`Only ${c.activeHours.toFixed(1)} active hours so far; the plan asks for ${TARGETS.minActiveHours}.`,
        ...(failed.length ? [`Already failing: ${failed.join(', ')}.`] : [])],
    };
  }
  if (unknown.length) {
    return { decision: 'Cannot judge', reasons: [`No measurement for: ${unknown.join(', ')}.`] };
  }
  if (!failed.length) {
    return {
      decision: 'Adopt is supported by the data',
      reasons: ['All trial targets are met.',
        'Before adopting, weigh the storage and mobile-data figures below and plan the move of the dashboard onto backend decoding.'],
    };
  }
  const transport = failed.filter((n) => n !== 'Decoding parity with the app');
  if (!transport.length) {
    return {
      decision: 'Revise the decoder, then re-check',
      reasons: ['Transport targets are met; decoding differs from the app on the fields listed under Parity.',
        'Fix those differences (or confirm the app is the one that is wrong) and re-run the comparison on the same period.'],
    };
  }
  return {
    decision: 'Revise the transport, or drop',
    reasons: [`Failing: ${failed.join(', ')}.`,
      'If batching, retry or network changes on the tablet cannot bring these within target, keep the current path.'],
  };
};

// ─────────────────────────── markdown ───────────────────────────

const num = (v, d = 0) => (v === null || v === undefined ? '–'
  : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (r, d = 2) => (r === null || r === undefined ? '–' : `${(r * 100).toFixed(d)}%`);
const iso = (ms) => new Date(ms).toISOString();
const mb = (b) => (b === null || b === undefined ? '–' : `${(b / 1_048_576).toFixed(1)} MB`);
const passMark = (p) => (p === true ? 'Pass' : p === false ? '**Fail**' : '–');
const targetValue = (t) => {
  if (t.value === null || t.value === undefined) return '–';
  if (t.unit === '%') return pct(t.value, 3);
  if (t.unit === 'h') return `${t.value.toFixed(1)} h`;
  return `${num(t.value)} ms`;
};

const renderComparison = (c) => {
  const n = c.newPath;
  const o = c.oldPath;
  const L = [];
  L.push(`# Raw CAN trial: old vs new architecture, vehicle ${c.vehicle}`, '');
  L.push(`Period: ${iso(c.fromMs)} to ${iso(c.toMs)} (${c.windows} daily window${c.windows === 1 ? '' : 's'}) · generated ${iso(c.generatedAtMs)}`);
  L.push(`Active time (raw CAN traffic seen): ${c.activeHours.toFixed(1)} h · decoder mode: ${c.evccFixed ? 'EVCC fixed' : 'as current app'}`, '');
  L.push('- **Old path:** the tablet decodes CAN frames and uploads a snapshot of about 110 fields every 2 s (`live_values`).');
  L.push('- **New path:** the tablet uploads the raw frames; the backend decodes them (`raw_can_batches`).', '');

  L.push('## Suggested decision', '');
  L.push(`**${c.verdict.decision}.**`, '');
  for (const r of c.verdict.reasons) L.push(`- ${r}`);
  L.push('', 'This is computed from the targets below; the decision stays with the team.', '');

  L.push('## Trial targets', '');
  L.push('| Target | Required | Measured | Result |', '|---|---|---|---|');
  for (const t of c.targets) L.push(`| ${t.name} | ${t.target} | ${targetValue(t)} | ${passMark(t.pass)} |`);
  L.push('');

  L.push('## Side by side (per active hour unless stated)', '');
  L.push('| Measure | Old path | New path | Notes |', '|---|---|---|---|');
  L.push(`| Data resolution | ${num(o.uploadsPerSecond, 2)} snapshots/s | ${num(n.framesPerSecond, 1)} frames/s | New path keeps every CAN frame |`);
  L.push(`| Completeness | ${pct(o.coverage)} of 2 s slots had an upload | ${pct(n.missingRate === null ? null : 1 - n.missingRate, 3)} of frames delivered | Old: ${num(o.gapsOver10s)} gaps over 10 s, longest ${num(o.longestGapMs === null ? null : o.longestGapMs / 1000, 0)} s. New: ${num(n.framesMissing)} frames missing |`);
  L.push(`| Timestamps | ${num(o.uploadsWithoutRecentFrames)} uploads with no CAN data in the 2 s before them | Each frame keeps its own receive time | Old uploads carry upload time, so stale values look current |`);
  L.push(`| Delay to server | Not measurable | p50 ${num(n.lagP50Ms)} ms, p95 ${num(n.lagP95Ms)} ms | \`live_values\` does not record when the server received a row |`);
  L.push(`| Database storage | ${mb(o.storedBytesPerHour)} | ${mb(n.storedBytesPerHour)} | Old: \`live_values\` rows. New: raw batches before any decoded output |`);
  L.push(`| Upload data (uncompressed JSON) | ${mb(o.requestBytesPerHour)} | ${mb(n.requestBytesPerHour)} | Estimates; HTTP/TLS overhead not included, neither path uses gzip |`);
  L.push(`| Duplicates | – | ${num(n.duplicateFrames)} duplicate frames, ${num(n.overlapBatches)} overlapping batches | Removed by the backend |`);
  L.push(`| Uploads outside CAN activity | ${num(o.uploadsOutsideActive)} | – | Old path uploading while the raw path saw no frames |`);
  L.push('');

  L.push('## Parity', '');
  L.push(`${pct(c.parity.matchRate, 3)} of ${num(c.parity.compared)} non-empty field comparisons matched, over ${num(c.parity.rowsCompared)} app uploads, allowing for the app's snapshot running up to 1 s behind its own frames (exact-time: ${pct(c.parity.exactMatchRate, 3)}).` + (c.parity.rowsAfterLoss ? ` ${num(c.parity.rowsAfterLoss)} uploads within 5 s after lost frames were not compared, since loss rather than decoding would explain any difference.` : ''), '');
  if (c.parity.worstFields.length) {
    L.push('| Field | Match rate | Mismatches | Example (app → backend) |', '|---|---|---|---|');
    for (const f of c.parity.worstFields) {
      const e = f.examples[0];
      const ex = e ? `${JSON.stringify(e.stored)} → ${JSON.stringify(e.rebuilt)} at ${iso(e.atMs)}` : '';
      L.push(`| ${f.field} | ${pct(f.matchRate, 3)} | ${num(f.mismatches)} | ${ex.replace(/\|/g, '\\|')} |`);
    }
  } else {
    L.push('No mismatching fields.');
  }
  L.push('');

  L.push('## Not captured by the numbers', '');
  L.push('- **Fixing decoding.** Old path: every decoding fix needs a new app build installed on each vehicle (the EVCC bug went unnoticed in production data). New path: fixed once on the server, and stored frames can be decoded again.');
  L.push('- **Signals not decoded today.** Old path: lost. New path: unknown CAN ids are stored and can be decoded later.');
  L.push('- **Tablet dependency.** Both paths depend on the tablet app running and online; the new path does not change that.');
  L.push('- **Tablet-only values.** Running hours and kWh are computed on the tablet and still need the old upload or a new source.');
  L.push('- **Build cost.** Adopting means moving the dashboard onto backend-decoded data and keeping one decoder specification for app and backend.');
  return L.join('\n');
};

module.exports = {
  TARGETS,
  SEGMENT_GAP_MS,
  activeSegments,
  buildComparison,
  evaluateTargets,
  verdict,
  renderComparison,
};
