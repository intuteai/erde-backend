// raw-can-trial/tests/analysis.test.js
const {
  EXCLUDED_FIELDS,
  percentile,
  summarize,
  lossBySession,
  volumeStats,
  compareValue,
  ParityTally,
  renderMarkdown,
} = require('../analysis');

const seqFrames = (seqs) => seqs.map((sequence) => ({ sequence }));

describe('EXCLUDED_FIELDS', () => {
  test('lists the tablet-only fields and is frozen', () => {
    expect(EXCLUDED_FIELDS).toEqual(['total_running_hrs', 'last_trip_hrs', 'total_kwh_consumed', 'last_trip_kwh']);
    expect(Object.isFrozen(EXCLUDED_FIELDS)).toBe(true);
  });
});

describe('percentile', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  test('nearest rank on a small array', () => {
    expect(percentile(arr, 50)).toBe(5);
    expect(percentile(arr, 95)).toBe(10);
    expect(percentile(arr, 100)).toBe(10);
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 51)).toBe(30);
  });

  test('single element', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  test('empty array gives null', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summarize', () => {
  test('ignores non-finite values and sorts numerically', () => {
    const s = summarize([10, NaN, 2, Infinity, -Infinity, 100, null, undefined, '5', 7]);
    expect(s).toEqual({ count: 4, min: 2, p50: 7, p95: 100, max: 100 });
  });

  test('empty input gives nulls', () => {
    expect(summarize([])).toEqual({ count: 0, min: null, p50: null, p95: null, max: null });
    expect(summarize([NaN, Infinity])).toEqual({ count: 0, min: null, p50: null, p95: null, max: null });
  });
});

describe('lossBySession', () => {
  test('no gaps', () => {
    const [s] = lossBySession([{ sessionId: 'a', frames: seqFrames([5, 6, 7, 8]) }]);
    expect(s).toEqual({
      sessionId: 'a', firstSequence: 5, lastSequence: 8, expected: 4, received: 4, missing: 0, gaps: [],
    });
  });

  test('single gap', () => {
    const [s] = lossBySession([{ sessionId: 'b', frames: seqFrames([1, 2, 6, 7]) }]);
    expect(s.gaps).toEqual([[3, 5]]);
    expect(s.expected).toBe(7);
    expect(s.received).toBe(4);
    expect(s.missing).toBe(3);
  });

  test('multiple gaps including a one-frame gap, and several sessions', () => {
    const result = lossBySession([
      { sessionId: 'c', frames: seqFrames([10, 12, 13, 20, 21]) },
      { sessionId: 'd', frames: seqFrames([0]) },
    ]);
    expect(result[0]).toEqual({
      sessionId: 'c', firstSequence: 10, lastSequence: 21, expected: 12, received: 5, missing: 7,
      gaps: [[11, 11], [14, 19]],
    });
    expect(result[1]).toEqual({
      sessionId: 'd', firstSequence: 0, lastSequence: 0, expected: 1, received: 1, missing: 0, gaps: [],
    });
  });
});

describe('volumeStats', () => {
  const sessions = [
    {
      frames: [
        { canId: 0x142, receivedAtMs: 1000 },
        { canId: 0x18FFC13A, receivedAtMs: 1500 },
        { canId: 0x142, receivedAtMs: 2000 },
        { canId: 0x142, receivedAtMs: 3000 },
      ],
    },
    {
      frames: [
        { canId: 0x7FF, receivedAtMs: 10000 },
        { canId: 0x18FFC13A, receivedAtMs: 12000 },
      ],
    },
  ];

  test('counts per id sorted desc, rates use active time, unknown ids flagged', () => {
    const v = volumeStats(sessions, [0x142, 0x18FFC13A]);
    expect(v.frames).toBe(6);
    expect(v.activeSeconds).toBe(4); // (3000-1000) + (12000-10000)
    expect(v.framesPerSecond).toBe(1.5);
    expect(v.perCanId).toEqual([
      { canId: '0x142', frames: 3, perSecond: 0.75, known: true },
      { canId: '0x18FFC13A', frames: 2, perSecond: 0.5, known: true },
      { canId: '0x7FF', frames: 1, perSecond: 0.25, known: false },
    ]);
    expect(v.unknownIds).toEqual(['0x7FF']);
  });

  test('zero active time gives null rates', () => {
    const v = volumeStats([{ frames: [{ canId: 0x142, receivedAtMs: 5000 }] }], [0x142]);
    expect(v.frames).toBe(1);
    expect(v.activeSeconds).toBe(0);
    expect(v.framesPerSecond).toBeNull();
    expect(v.perCanId).toEqual([{ canId: '0x142', frames: 1, perSecond: null, known: true }]);
    expect(v.unknownIds).toEqual([]);
  });
});

describe('compareValue', () => {
  const num2 = { dataType: 'numeric', scale: 2 };
  const num3 = { dataType: 'numeric', scale: 3 };
  const int = { dataType: 'integer', scale: 0 };
  const text = { dataType: 'character varying', scale: null };
  const json = { dataType: 'jsonb', scale: null };

  test('null handling', () => {
    expect(compareValue(num2, null, null)).toBe('both-null');
    expect(compareValue(num2, undefined, null)).toBe('both-null');
    expect(compareValue(num2, null, undefined)).toBe('both-null');
    expect(compareValue(num2, null, 80)).toBe('mismatch');
    expect(compareValue(num2, '80.00', undefined)).toBe('mismatch');
    expect(compareValue(text, 'x', null)).toBe('mismatch');
  });

  test('numeric scale 2 tolerance', () => {
    expect(compareValue(num2, '80.00', 80)).toBe('match');
    expect(compareValue(num2, '80.00', 80.004)).toBe('match');
    expect(compareValue(num2, '80.00', 79.996)).toBe('match');
    expect(compareValue(num2, '80.00', 80.006)).toBe('mismatch');
    expect(compareValue(num2, '80.00', 79.994)).toBe('mismatch');
  });

  test('numeric scale 3 tolerance', () => {
    expect(compareValue(num3, '1.234', 1.2344)).toBe('match');
    expect(compareValue(num3, '1.234', 1.2346)).toBe('mismatch');
  });

  test('integer columns (scale 0)', () => {
    expect(compareValue(int, 5, 5)).toBe('match');
    expect(compareValue(int, 5, 5.4)).toBe('match');
    expect(compareValue(int, 5, 5.6)).toBe('mismatch');
    expect(compareValue({ dataType: 'smallint', scale: 0 }, 5, 4.6)).toBe('match');
  });

  test('-0 vs "0" match', () => {
    expect(compareValue(num2, '0', -0)).toBe('match');
    expect(compareValue(int, -0, '0')).toBe('match');
  });

  test('non-numeric string in numeric column is a mismatch', () => {
    expect(compareValue(num2, 'abc', 80)).toBe('mismatch');
    expect(compareValue(num2, '80.00', 'n/a')).toBe('mismatch');
    expect(compareValue(int, 5, NaN)).toBe('mismatch');
  });

  test('varchar compares exact strings', () => {
    expect(compareValue(text, 'READY', 'READY')).toBe('match');
    expect(compareValue(text, 'READY', 'ready')).toBe('mismatch');
    expect(compareValue(text, 'READY', 'READY ')).toBe('mismatch');
    expect(compareValue(text, '1', 1)).toBe('match');
  });

  test('jsonb deep compare, key order independent, arrays order sensitive', () => {
    expect(compareValue(json, { a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toBe('match');
    expect(compareValue(json, { a: [1, 2] }, { a: [2, 1] })).toBe('mismatch');
    expect(compareValue(json, { a: 1 }, { a: 1, b: 2 })).toBe('mismatch');
    expect(compareValue(json, { a: 1 }, { a: '1' })).toBe('mismatch');
  });

  test('jsonb null grids are equal', () => {
    const grid = [[null, null], [null, null]];
    expect(compareValue(json, { cells: grid }, { cells: [[null, null], [null, null]] })).toBe('match');
    expect(compareValue(json, grid, [[null, null], [null, null]])).toBe('match');
    expect(compareValue(json, [null, null], [null, 1])).toBe('mismatch');
  });
});

describe('ParityTally', () => {
  test('add() counts outcomes and caps examples at 5', () => {
    const t = new ParityTally();
    t.add('soc', 'both-null', 1, null, null);
    t.add('soc', 'match', 2, '80.00', 80);
    for (let i = 0; i < 7; i++) t.add('soc', 'mismatch', 100 + i, `${i}.00`, i + 1);
    const f = t.fields.get('soc');
    expect(f.rows).toBe(9);
    expect(f.bothNull).toBe(1);
    expect(f.matches).toBe(1);
    expect(f.mismatches).toBe(7);
    expect(f.examples).toHaveLength(5);
    expect(f.examples[0]).toEqual({ atMs: 100, stored: '0.00', rebuilt: 1 });
    expect(f.examples[4]).toEqual({ atMs: 104, stored: '4.00', rebuilt: 5 });
  });

  test('addRow compares alarms flag by flag across both sides', () => {
    const columns = new Map([
      ['soc', { dataType: 'numeric', scale: 2 }],
      ['alarms', { dataType: 'jsonb', scale: null }],
    ]);
    const t = new ParityTally();
    t.addRow(
      1000,
      { soc: '80.00', alarms: { faults: { overTemp: true, lowSoc: false, onlyStored: true } } },
      { soc: 80, alarms: { faults: { overTemp: true, lowSoc: true, onlyRebuilt: false } } },
      columns,
    );
    const r = t.results();
    const byField = Object.fromEntries(r.fields.map((f) => [f.field, f]));
    expect(Object.keys(byField).sort()).toEqual(
      ['alarms.lowSoc', 'alarms.onlyRebuilt', 'alarms.onlyStored', 'alarms.overTemp', 'soc'],
    );
    expect(byField.alarms).toBeUndefined();
    expect(byField.soc.matches).toBe(1);
    expect(byField['alarms.overTemp'].matches).toBe(1);
    expect(byField['alarms.lowSoc'].mismatches).toBe(1);
    expect(byField['alarms.onlyStored'].mismatches).toBe(1);
    expect(byField['alarms.onlyStored'].examples).toEqual([{ atMs: 1000, stored: true, rebuilt: undefined }]);
    expect(byField['alarms.onlyRebuilt'].mismatches).toBe(1);
    expect(byField['alarms.onlyRebuilt'].examples).toEqual([{ atMs: 1000, stored: undefined, rebuilt: false }]);
  });

  test('addRow tolerates missing alarms objects', () => {
    const t = new ParityTally();
    t.addRow(1, { alarms: null }, {}, [['alarms', { dataType: 'jsonb', scale: null }]]);
    expect(t.results().fields).toEqual([]);
  });

  test('results orders worst first, all-empty fields last, overall excludes both-null', () => {
    const columns = new Map([
      ['a_good', { dataType: 'integer', scale: 0 }],
      ['b_bad', { dataType: 'integer', scale: 0 }],
      ['c_empty', { dataType: 'integer', scale: 0 }],
      ['d_half', { dataType: 'integer', scale: 0 }],
    ]);
    const t = new ParityTally();
    t.addRow(1, { a_good: 1, b_bad: 1, c_empty: null, d_half: 1 }, { a_good: 1, b_bad: 2, d_half: 1 }, columns);
    t.addRow(2, { a_good: 2, b_bad: 1, c_empty: null, d_half: 1 }, { a_good: 2, b_bad: 2, d_half: 9 }, columns);
    t.addRow(3, { a_good: null, b_bad: null, c_empty: null, d_half: null }, {}, columns);

    const r = t.results();
    expect(r.fields.map((f) => f.field)).toEqual(['b_bad', 'd_half', 'a_good', 'c_empty']);
    expect(r.fields.map((f) => f.matchRate)).toEqual([0, 0.5, 1, null]);
    const empty = r.fields[3];
    expect(empty).toMatchObject({ rows: 3, bothNull: 3, compared: 0, matches: 0, mismatches: 0 });
    expect(r.fields[0]).toMatchObject({ rows: 3, bothNull: 1, compared: 2 });
    expect(r.compared).toBe(6);
    expect(r.matches).toBe(3);
    expect(r.matchRate).toBe(0.5);
  });

  test('empty tally', () => {
    expect(new ParityTally().results()).toEqual({ fields: [], compared: 0, matches: 0, matchRate: null });
  });
});

describe('renderMarkdown', () => {
  const buildReport = (evccFixed) => {
    const loss = lossBySession([
      { sessionId: 'sess-1', frames: seqFrames([...Array.from({ length: 40 }, (_, i) => i + 1), 51, 52, 54, 55]) },
    ]);
    const volume = volumeStats([
      {
        frames: [
          { canId: 0x142, receivedAtMs: 0 },
          { canId: 0x142, receivedAtMs: 1000 },
          { canId: 0x7FF, receivedAtMs: 2000 },
        ],
      },
    ], [0x142]);
    const columns = new Map([
      ['soc', { dataType: 'numeric', scale: 2 }],
      ['gear', { dataType: 'character varying', scale: null }],
      ['empty_col', { dataType: 'integer', scale: 0 }],
    ]);
    const tally = new ParityTally();
    tally.addRow(Date.UTC(2026, 9, 1, 10), { soc: '80.00', gear: 'D|N', empty_col: null }, { soc: 80, gear: 'R' }, columns);
    tally.addRow(Date.UTC(2026, 9, 1, 11), { soc: '81.00', gear: 'D', empty_col: null }, { soc: 81, gear: 'D' }, columns);
    return {
      vehicle: 'KA01AB1234',
      fromMs: Date.UTC(2026, 9, 1, 0),
      toMs: Date.UTC(2026, 9, 2, 0),
      generatedAtMs: Date.UTC(2026, 9, 2, 1),
      evccFixed,
      ingest: {
        batches: 1200,
        overlapBatches: 3,
        frames: 44,
        duplicateFrames: 2,
        batchesPerMinute: 12.5,
        framesPerBatch: 3.7,
        storedBytes: 2048,
        bytesPerActiveHour: 5 * 1024 * 1024,
        tableBytes: 3 * 1024 * 1024 * 1024,
      },
      loss,
      timing: {
        frameLagMs: summarize([100, 200, 300, 900]),
        batchTransitMs: summarize([50, 60]),
        batchingMs: summarize([]),
      },
      volume,
      parity: { appRows: 10, rowsCompared: 2, rowsWithoutRecentFrames: 5, rowsBeforeFirstSession: 3, ...tally.results() },
    };
  };

  test('renders all sections with key values', () => {
    const md = renderMarkdown(buildReport(true));
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Raw CAN trial report: vehicle KA01AB1234');
    for (const h of ['## Summary', '## Loss', '## Timing', '## Volume', '## Parity', '### Mismatch examples']) {
      expect(lines).toContain(h);
    }
    expect(md).toContain('Window: 2026-10-01T00:00:00.000Z to 2026-10-02T00:00:00.000Z');
    expect(md).toContain('Decoder mode: EVCC fixed (app build with the EVCC fix)');

    // summary
    expect(md).toContain('| Batches stored | 1,200 (3 flagged as overlapping) |');
    expect(md).toContain('| Frames missing (sequence gaps) | 11 of 55 expected (20.000%) |');
    expect(md).toContain('| Tablet to server delay, p95 | 900 ms (target ≤ 750 ms) |');
    expect(md).toContain('| Frame rate | 1.5 frames/s while active |');
    expect(md).toContain('| Parity | 75.000% of 4 non-empty field comparisons (target ≥ 99.9%) |');

    // loss: multi-frame gap and single-frame gap
    expect(md).toContain('| `sess-1` | 1–55 | 55 | 44 | 11 | 41–50, 53 |');

    // timing with empty summary
    expect(md).toContain('| Frame received on tablet → batch stored on server | 4 | 200 | 900 | 100 | 900 |');
    expect(md).toContain('| First frame in batch → batch finalised (tablet batching) | 0 | – | – | – | – |');

    // volume
    expect(md).toContain('- Unknown CAN ids: 0x7FF');
    expect(md).toContain('| 0x142 | 2 | 1.00 | yes |');
    expect(md).toContain('| 0x7FF | 1 | 0.50 | no |');
    expect(md).toContain('2.0 KB (5.0 MB per active hour); whole raw_can_batches table: 3.0 GB');

    // parity
    expect(md).toContain('| gear | 50.000% | 2 | 1 | 0 |');
    expect(md).toContain('| soc | 100.000% | 2 | 0 | 0 |');
    expect(md).not.toContain('| empty_col |');
    expect(md).toContain('Empty on both sides in every compared row (1): empty_col');
    expect(md).toContain(`- Excluded fields (tablet-only): ${EXCLUDED_FIELDS.join(', ')}`);
    expect(md).toContain('| gear | 2026-10-01T10:00:00.000Z | "D\\|N" | "R" |');
  });

  test('decoder mode wording when EVCC is not fixed', () => {
    const md = renderMarkdown(buildReport(false));
    expect(md).toContain('Decoder mode: as current app (EVCC control and status 2 fail to decode)');
  });

  test('no gaps, no unknown ids, no mismatches', () => {
    const r = buildReport(true);
    r.loss = lossBySession([{ sessionId: 's', frames: seqFrames([1, 2, 3]) }]);
    r.volume = volumeStats([{ frames: [{ canId: 0x142, receivedAtMs: 0 }, { canId: 0x142, receivedAtMs: 1000 }] }], [0x142]);
    const t = new ParityTally();
    t.add('soc', 'match', 1, '1.00', 1);
    r.parity = { appRows: 1, rowsCompared: 1, rowsWithoutRecentFrames: 0, rowsBeforeFirstSession: 0, ...t.results() };
    const md = renderMarkdown(r);
    expect(md).toContain('| `s` | 1–3 | 3 | 3 | 0 | none |');
    expect(md).toContain('- Unknown CAN ids: none');
    expect(md).toContain('Empty on both sides in every compared row (0): none');
    expect(md).not.toContain('### Mismatch examples');
  });

  test('more than 10 gaps are truncated', () => {
    const r = buildReport(true);
    const seqs = [];
    for (let i = 0; i < 13; i++) seqs.push(i * 2);
    r.loss = lossBySession([{ sessionId: 'g', frames: seqFrames(seqs) }]);
    const md = renderMarkdown(r);
    expect(md).toContain('1, 3, 5, 7, 9, 11, 13, 15, 17, 19 (+2 more) |');
  });
});

describe('ParityTally.addRowCandidates', () => {
  const cols = new Map([['soc_percent', { dataType: 'numeric', scale: 2 }], ['alarms', { dataType: 'jsonb', scale: null }]]);
  const live = (soc, low) => ({ soc_percent: soc, alarms: { faults: { bms_soc_low: low } } });

  it('matches when any candidate equals the stored value, and reports the last candidate otherwise', () => {
    const t = new ParityTally();
    t.addRowCandidates(1, { soc_percent: '60.00', alarms: { faults: { bms_soc_low: true } } },
      [live(80, false), live(60, true), live(70, false)], cols);
    t.addRowCandidates(2, { soc_percent: '55.00', alarms: { faults: { bms_soc_low: false } } },
      [live(80, false), live(70, false)], cols);
    const byField = Object.fromEntries(t.results().fields.map((f) => [f.field, f]));
    expect(byField.soc_percent.matches).toBe(1);
    expect(byField.soc_percent.mismatches).toBe(1);
    expect(byField.soc_percent.examples[0]).toEqual({ atMs: 2, stored: '55.00', rebuilt: 70 });
    expect(byField['alarms.bms_soc_low'].matches).toBe(2);
  });

  it('treats a stored null as both-null when some candidate is null', () => {
    const t = new ParityTally();
    t.addRowCandidates(1, { soc_percent: null, alarms: { faults: {} } }, [live(null, false), live(80, false)], cols);
    const f = t.results().fields.find((x) => x.field === 'soc_percent');
    expect(f.bothNull).toBe(1);
    expect(f.mismatches).toBe(0);
  });
});
