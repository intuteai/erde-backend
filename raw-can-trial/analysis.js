// raw-can-trial/analysis.js
// Pure calculations for the trial report: loss, timing, volume and parity.
// No database access here, so everything can be unit tested.
const { canIdString } = require('./decoders');

/** Tablet-only values the backend cannot rebuild from CAN frames. */
const EXCLUDED_FIELDS = Object.freeze([
  'total_running_hrs', 'last_trip_hrs', 'total_kwh_consumed', 'last_trip_kwh',
]);

const NUMERIC_TYPES = new Set(['numeric', 'integer', 'smallint', 'bigint', 'real', 'double precision']);

// ─────────────────────────── statistics ───────────────────────────

/** Nearest-rank percentile of an ascending array. */
const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

const summarize = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
};

// ─────────────────────────── loss ───────────────────────────

/**
 * Sequence gaps per session. Frames lost before the first or after the last
 * received frame of a session cannot be seen and are not counted.
 * @param {Array<{ sessionId: string, frames: Array<{ sequence: number }> }>} sessions frames sorted, unique
 */
const lossBySession = (sessions) => sessions.map(({ sessionId, frames }) => {
  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].sequence;
    const cur = frames[i].sequence;
    if (cur > prev + 1) gaps.push([prev + 1, cur - 1]);
  }
  const first = frames[0].sequence;
  const last = frames[frames.length - 1].sequence;
  const expected = last - first + 1;
  return {
    sessionId,
    firstSequence: first,
    lastSequence: last,
    expected,
    received: frames.length,
    missing: expected - frames.length,
    gaps,
  };
});

// ─────────────────────────── volume ───────────────────────────

/** Frame counts and rates per CAN id, over the time the sessions were active. */
const volumeStats = (sessions, knownIds) => {
  const perId = new Map();
  let frames = 0;
  let activeMs = 0;

  for (const s of sessions) {
    activeMs += s.frames[s.frames.length - 1].receivedAtMs - s.frames[0].receivedAtMs;
    for (const f of s.frames) {
      frames += 1;
      perId.set(f.canId, (perId.get(f.canId) || 0) + 1);
    }
  }
  return volumeFromCounts(perId, frames, activeMs, knownIds);
};

/** Same result as volumeStats(), from counts already added up (e.g. over several windows). */
const volumeFromCounts = (perId, frames, activeMs, knownIds) => {
  const known = new Set(knownIds);
  const activeSec = activeMs / 1000;
  const rate = (n) => (activeSec > 0 ? n / activeSec : null);
  const ids = [...perId.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ canId: canIdString(id), frames: n, perSecond: rate(n), known: known.has(id) }));

  return {
    frames,
    activeSeconds: activeSec,
    framesPerSecond: rate(frames),
    perCanId: ids,
    unknownIds: ids.filter((x) => !x.known).map((x) => x.canId),
  };
};

// ─────────────────────────── parity ───────────────────────────

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
};

/**
 * Compares a value stored in live_values with the value the backend rebuilt.
 * Numbers match within half a unit of the column's stored precision.
 * @param {{ dataType: string, scale: number|null }} meta column type
 * @returns {'both-null'|'match'|'mismatch'}
 */
const compareValue = (meta, stored, rebuilt) => {
  const storedNull = stored === null || stored === undefined;
  const rebuiltNull = rebuilt === null || rebuilt === undefined;
  if (storedNull && rebuiltNull) return 'both-null';
  if (storedNull || rebuiltNull) return 'mismatch';

  if (NUMERIC_TYPES.has(meta.dataType)) {
    const a = Number(stored);
    const b = Number(rebuilt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'mismatch';
    const tolerance = 0.5 * 10 ** -(meta.scale || 0) + 1e-9;
    return Math.abs(a - b) <= tolerance ? 'match' : 'mismatch';
  }
  if (meta.dataType === 'jsonb') return canonical(stored) === canonical(rebuilt) ? 'match' : 'mismatch';
  return String(stored) === String(rebuilt) ? 'match' : 'mismatch';
};

const MAX_EXAMPLES = 5;

/** Collects per-field comparison results across many rows. */
class ParityTally {
  constructor() {
    this.fields = new Map();
  }

  add(field, outcome, atMs, stored, rebuilt) {
    if (!this.fields.has(field)) {
      this.fields.set(field, { field, rows: 0, bothNull: 0, matches: 0, mismatches: 0, examples: [] });
    }
    const f = this.fields.get(field);
    f.rows += 1;
    if (outcome === 'both-null') f.bothNull += 1;
    else if (outcome === 'match') f.matches += 1;
    else {
      f.mismatches += 1;
      if (f.examples.length < MAX_EXAMPLES) f.examples.push({ atMs, stored, rebuilt });
    }
  }

  /**
   * Compares one live_values row with the rebuilt snapshot at the same moment.
   * The alarms object is compared flag by flag.
   */
  addRow(atMs, storedRow, rebuiltLive, columns) {
    for (const [field, meta] of columns) {
      if (field === 'alarms') {
        const stored = storedRow.alarms?.faults || {};
        const rebuilt = rebuiltLive.alarms?.faults || {};
        for (const flag of new Set([...Object.keys(stored), ...Object.keys(rebuilt)])) {
          this.add(`alarms.${flag}`, compareValue({ dataType: 'boolean' }, stored[flag], rebuilt[flag]),
            atMs, stored[flag], rebuilt[flag]);
        }
        continue;
      }
      this.add(field, compareValue(meta, storedRow[field], rebuiltLive[field]),
        atMs, storedRow[field], rebuiltLive[field]);
    }
  }

  /**
   * Like addRow(), but a field matches if the stored value equals the rebuilt value
   * in ANY of the candidate snapshots (states in the moments before the upload).
   * Mismatch examples show the last candidate, i.e. the state at the upload time.
   */
  addRowCandidates(atMs, storedRow, candidates, columns) {
    const pick = (outcomes) => (outcomes.includes('match') ? 'match'
      : outcomes.includes('both-null') ? 'both-null' : 'mismatch');
    const last = candidates[candidates.length - 1];

    for (const [field, meta] of columns) {
      if (field === 'alarms') {
        const stored = storedRow.alarms?.faults || {};
        const flags = new Set(Object.keys(stored));
        for (const c of candidates) for (const k of Object.keys(c.alarms?.faults || {})) flags.add(k);
        for (const flag of flags) {
          const outcome = pick(candidates.map((c) =>
            compareValue({ dataType: 'boolean' }, stored[flag], c.alarms?.faults?.[flag])));
          this.add(`alarms.${flag}`, outcome, atMs, stored[flag], last.alarms?.faults?.[flag]);
        }
        continue;
      }
      const outcome = pick(candidates.map((c) => compareValue(meta, storedRow[field], c[field])));
      this.add(field, outcome, atMs, storedRow[field], last[field]);
    }
  }

  /** Fields ordered worst first. matchRate counts only rows where a side had a value. */
  results() {
    const list = [...this.fields.values()].map((f) => {
      const compared = f.matches + f.mismatches;
      return { ...f, compared, matchRate: compared ? f.matches / compared : null };
    });
    list.sort((a, b) => (a.matchRate ?? 2) - (b.matchRate ?? 2) || a.field.localeCompare(b.field));
    const compared = list.reduce((n, f) => n + f.compared, 0);
    const matches = list.reduce((n, f) => n + f.matches, 0);
    return { fields: list, compared, matches, matchRate: compared ? matches / compared : null };
  }
}

// ─────────────────────────── markdown ───────────────────────────

const fmt = (v, digits = 0) => {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') {
    return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return String(v);
};
const pct = (r) => (r === null || r === undefined ? '–' : `${(r * 100).toFixed(3)}%`);
const iso = (ms) => (ms === null || ms === undefined ? '–' : new Date(ms).toISOString());
const bytes = (n) => {
  if (n === null || n === undefined) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const cell = (v) => (v === undefined ? '' : JSON.stringify(v)).replace(/\|/g, '\\|');
const summaryRow = (label, s) => `| ${label} | ${fmt(s.count)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.min)} | ${fmt(s.max)} |`;

/** Renders the report object assembled by scripts/report.js. */
const renderMarkdown = (r) => {
  const L = [];
  const lossTotals = r.loss.reduce((t, s) => ({
    expected: t.expected + s.expected, received: t.received + s.received, missing: t.missing + s.missing,
  }), { expected: 0, received: 0, missing: 0 });

  L.push(`# Raw CAN trial report: vehicle ${r.vehicle}`, '');
  L.push(`Window: ${iso(r.fromMs)} to ${iso(r.toMs)} · generated ${iso(r.generatedAtMs)}`);
  L.push(`Decoder mode: ${r.evccFixed ? 'EVCC fixed (app build with the EVCC fix)' : 'as current app (EVCC control and status 2 fail to decode)'}`, '');

  L.push('## Summary', '');
  L.push('| Measure | Result |', '|---|---|');
  L.push(`| Batches stored | ${fmt(r.ingest.batches)} (${fmt(r.ingest.overlapBatches)} flagged as overlapping) |`);
  L.push(`| Frames stored | ${fmt(r.ingest.frames)} in ${fmt(r.loss.length)} session(s); ${fmt(r.ingest.duplicateFrames)} duplicate frames dropped |`);
  L.push(`| Frames missing (sequence gaps) | ${fmt(lossTotals.missing)} of ${fmt(lossTotals.expected)} expected (${pct(lossTotals.expected ? lossTotals.missing / lossTotals.expected : null)}) |`);
  L.push(`| Tablet to server delay, p95 | ${fmt(r.timing.frameLagMs.p95)} ms (target ≤ 750 ms) |`);
  L.push(`| Frame rate | ${fmt(r.volume.framesPerSecond, 1)} frames/s while active |`);
  L.push(`| Parity | ${pct(r.parity.matchRate)} of ${fmt(r.parity.compared)} non-empty field comparisons (target ≥ 99.9%)${r.parity.windowMs ? `; exact-time ${pct(r.parity.exactMatchRate)}` : ''} |`);
  L.push('');

  L.push('## Loss', '');
  L.push('| Session | Sequences | Expected | Received | Missing | Gaps |', '|---|---|---|---|---|---|');
  for (const s of r.loss) {
    const gaps = s.gaps.slice(0, 10).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
      + (s.gaps.length > 10 ? ` (+${s.gaps.length - 10} more)` : '');
    L.push(`| \`${s.sessionId}\` | ${s.firstSequence}–${s.lastSequence} | ${fmt(s.expected)} | ${fmt(s.received)} | ${fmt(s.missing)} | ${gaps || 'none'} |`);
  }
  L.push('', 'Frames lost before the first or after the last frame a session delivered cannot be detected.', '');

  L.push('## Timing', '');
  L.push('| Measure (ms) | Count | p50 | p95 | Min | Max |', '|---|---|---|---|---|---|');
  L.push(summaryRow('Frame received on tablet → batch stored on server', r.timing.frameLagMs));
  L.push(summaryRow('Batch finalised on tablet → stored on server (queue wait + network)', r.timing.batchTransitMs));
  L.push(summaryRow('First frame in batch → batch finalised (tablet batching)', r.timing.batchingMs));
  L.push('', 'All tablet times come from the tablet clock. "Finalised" is when the app writes the batch to its disk queue (sentAtMs in the contract), so the second row includes time spent queued, for example while offline. A negative value there means the tablet clock is ahead of the server, and the first row cannot be trusted.', '');

  L.push('## Volume', '');
  L.push(`- Active time: ${fmt(r.volume.activeSeconds / 3600, 2)} h; ${fmt(r.volume.frames)} frames; ${fmt(r.volume.framesPerSecond, 1)} frames/s`);
  L.push(`- Requests: ${fmt(r.ingest.batches)} batches, ${fmt(r.ingest.batchesPerMinute, 1)} per active minute, ${fmt(r.ingest.framesPerBatch, 1)} frames per batch on average`);
  L.push(`- Stored size of these batches: ${bytes(r.ingest.storedBytes)} (${bytes(r.ingest.bytesPerActiveHour)} per active hour); whole raw_can_batches table: ${bytes(r.ingest.tableBytes)}`);
  L.push(`- Unknown CAN ids: ${r.volume.unknownIds.length ? r.volume.unknownIds.join(', ') : 'none'}`, '');
  L.push('| CAN id | Frames | Per second | Decoded by app |', '|---|---|---|---|');
  for (const x of r.volume.perCanId) L.push(`| ${x.canId} | ${fmt(x.frames)} | ${fmt(x.perSecond, 2)} | ${x.known ? 'yes' : 'no'} |`);
  L.push('');

  L.push('## Parity', '');
  L.push(`Each app upload in \`live_values\` (${fmt(r.parity.appRows)} rows) is compared with the state the backend rebuilds from raw frames` + (r.parity.windowMs ? ` in the ${fmt(r.parity.windowMs)} ms before the upload's tablet time: a field matches if the backend held the app's value at any moment in that window, because the app's snapshot runs slightly behind its own frames.` : ' at the same tablet time.'));
  if (r.parity.exactMatchRate !== undefined) L.push(`- Exact-time parity (state at the upload's timestamp only): ${pct(r.parity.exactMatchRate)}`);
  L.push(`- Compared: ${fmt(r.parity.rowsCompared)} rows`);
  L.push(`- Not compared, no raw frame in the 2 s before the upload: ${fmt(r.parity.rowsWithoutRecentFrames)} rows (the app uploaded while the raw path delivered nothing, or frames were lost)`);
  if (r.parity.rowsAfterLoss !== undefined) {
    L.push(`- Not compared, within 5 s after lost frames: ${fmt(r.parity.rowsAfterLoss)} rows (the app may still hold values the raw path never received)`);
  }
  L.push(`- Not compared, before the first raw session: ${fmt(r.parity.rowsBeforeFirstSession)} rows`);
  L.push(`- Excluded fields (tablet-only): ${EXCLUDED_FIELDS.join(', ')}`, '');
  L.push('| Field | Match rate | Compared | Mismatches | Both empty |', '|---|---|---|---|---|');
  for (const f of r.parity.fields) {
    if (f.compared === 0) continue;
    L.push(`| ${f.field} | ${pct(f.matchRate)} | ${fmt(f.compared)} | ${fmt(f.mismatches)} | ${fmt(f.bothNull)} |`);
  }
  const alwaysEmpty = r.parity.fields.filter((f) => f.compared === 0).map((f) => f.field);
  L.push('', `Empty on both sides in every compared row (${alwaysEmpty.length}): ${alwaysEmpty.join(', ') || 'none'}`, '');

  const withExamples = r.parity.fields.filter((f) => f.examples.length);
  if (withExamples.length) {
    L.push('### Mismatch examples', '');
    L.push('| Field | Tablet time | App value (live_values) | Backend value |', '|---|---|---|---|');
    for (const f of withExamples) {
      for (const e of f.examples) L.push(`| ${f.field} | ${iso(e.atMs)} | ${cell(e.stored)} | ${cell(e.rebuilt)} |`);
    }
    L.push('');
  }
  return L.join('\n');
};

module.exports = {
  EXCLUDED_FIELDS,
  percentile,
  summarize,
  lossBySession,
  volumeStats,
  volumeFromCounts,
  compareValue,
  ParityTally,
  renderMarkdown,
};
