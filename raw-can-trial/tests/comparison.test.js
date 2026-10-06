// raw-can-trial/tests/comparison.test.js
const {
  TARGETS,
  SEGMENT_GAP_MS,
  activeSegments,
  buildComparison,
  evaluateTargets,
  verdict,
  renderComparison,
} = require('../comparison');
const { ParityTally } = require('../analysis');

const HOUR = 3_600_000;

/** Same shape as trialMetrics.createAccumulator(), built by hand (no DB module). */
const makeAcc = (overrides = {}) => {
  const { old = {}, ...rest } = overrides;
  return {
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
    rowsBeforeFirstSession: 0,
    old: {
      rowsInActive: 0,
      rowsOutsideActive: 0,
      expectedSlots: 0,
      gapsOver10s: 0,
      longestGapMs: 0,
      storedBytes: 0,
      uploadJsonBytes: 0,
      uploadsSized: 0,
      ...old,
    },
    segmentMs: 0,
    ...rest,
  };
};

const META = { vehicle: 'EV-0042', fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 8, 8), evccFixed: false };

/** Tally with `matches` matches and `mismatches` mismatches on a single field. */
const tallyWith = (matches, mismatches, field = 'soc') => {
  const t = new ParityTally();
  for (let i = 0; i < matches; i++) t.add(field, 'match', 0, 1, 1);
  for (let i = 0; i < mismatches; i++) t.add(field, 'mismatch', Date.UTC(2026, 8, 2), 50, 51);
  return t;
};

/** 100 lag values 1..100 scaled so p95 equals `p95`. */
const lagWithP95 = (p95) => Array.from({ length: 100 }, (_, i) => ((i + 1) * p95) / 95);

/** An accumulator that meets every target exactly at the boundary. */
const passingAcc = (overrides = {}) => makeAcc({
  segmentMs: TARGETS.minActiveHours * HOUR,
  loss: [{ expected: 1000, missing: 1 }],
  frameLag: lagWithP95(TARGETS.maxLagP95Ms),
  tally: tallyWith(999, 1),
  ...overrides,
});

const session = (times) => ({ frames: times.map((receivedAtMs) => ({ receivedAtMs })) });

describe('activeSegments', () => {
  test('empty input gives no segments', () => {
    expect(activeSegments([], 0, 1e12)).toEqual([]);
    expect(activeSegments([session([])], 0, 1e12)).toEqual([]);
  });

  test('frames within 10 s join one segment; more than 10 s apart splits', () => {
    const times = [1000, 1000 + SEGMENT_GAP_MS, 1000 + 2 * SEGMENT_GAP_MS, 1000 + 3 * SEGMENT_GAP_MS + 1, 1000 + 3 * SEGMENT_GAP_MS + 500];
    expect(activeSegments([session(times)], 0, 1e12)).toEqual([
      { startMs: 1000, endMs: 1000 + 2 * SEGMENT_GAP_MS },
      { startMs: 1000 + 3 * SEGMENT_GAP_MS + 1, endMs: 1000 + 3 * SEGMENT_GAP_MS + 500 },
    ]);
  });

  test('frames outside [fromMs, toMs) are ignored', () => {
    const segs = activeSegments([session([500, 1000, 2000, 3000, 4000])], 1000, 4000);
    expect(segs).toEqual([{ startMs: 1000, endMs: 3000 }]);
  });

  test('frames from several sessions are merged in time order', () => {
    const segs = activeSegments([session([5000, 1000]), session([3000, 50_000, 52_000])], 0, 1e12);
    expect(segs).toEqual([
      { startMs: 1000, endMs: 5000 },
      { startMs: 50_000, endMs: 52_000 },
    ]);
  });

  test('single-frame (zero length) segments are dropped', () => {
    const segs = activeSegments([session([1000, 100_000, 200_000, 201_000])], 0, 1e12);
    expect(segs).toEqual([{ startMs: 200_000, endMs: 201_000 }]);
  });
});

describe('buildComparison', () => {
  test('frame loss arithmetic sums acc.loss entries', () => {
    const c = buildComparison(makeAcc({ loss: [{ expected: 600, missing: 3 }, { expected: 400, missing: 2 }] }), META);
    expect(c.newPath.framesExpected).toBe(1000);
    expect(c.newPath.framesMissing).toBe(5);
    expect(c.newPath.framesReceived).toBe(995);
    expect(c.newPath.missingRate).toBeCloseTo(0.005, 12);
  });

  test('missingRate is null with no expected frames', () => {
    expect(buildComparison(makeAcc(), META).newPath.missingRate).toBeNull();
  });

  test('lag percentiles use nearest rank and ignore non-finite values', () => {
    const frameLag = [...Array.from({ length: 20 }, (_, i) => 20 - i), NaN, Infinity];
    const c = buildComparison(makeAcc({ frameLag }), META);
    expect(c.newPath.lagP50Ms).toBe(10);
    expect(c.newPath.lagP95Ms).toBe(19);
    expect(frameLag[0]).toBe(20); // input not mutated
  });

  test('lag percentiles are null when there is no lag data', () => {
    const c = buildComparison(makeAcc(), META);
    expect(c.newPath.lagP50Ms).toBeNull();
    expect(c.newPath.lagP95Ms).toBeNull();
  });

  test('framesPerSecond and per-hour figures all use segmentMs as active time', () => {
    const c = buildComparison(makeAcc({
      volumeFrames: 5000,
      activeMs: 10_000,
      segmentMs: 2 * HOUR,
      storedBytes: 1000,
      requestBytes: 3000,
      old: { storedBytes: 400 },
    }), META);
    expect(c.activeHours).toBe(2);
    expect(c.newPath.framesPerSecond).toBeCloseTo(5000 / 7200, 10);
    expect(c.newPath.storedBytesPerHour).toBe(500);
    expect(c.newPath.requestBytesPerHour).toBe(1500);
    expect(c.oldPath.storedBytesPerHour).toBe(200);
  });

  test('rates and per-hour figures are null with no active time', () => {
    const c = buildComparison(makeAcc({ volumeFrames: 10, storedBytes: 10 }), META);
    expect(c.newPath.framesPerSecond).toBeNull();
    expect(c.newPath.storedBytesPerHour).toBeNull();
    expect(c.oldPath.uploadsPerSecond).toBeNull();
  });

  test('old-path coverage is rowsInActive / expectedSlots, capped at 1, null without slots', () => {
    expect(buildComparison(makeAcc({ old: { rowsInActive: 90, expectedSlots: 100 } }), META).oldPath.coverage).toBe(0.9);
    expect(buildComparison(makeAcc({ old: { rowsInActive: 120, expectedSlots: 100 } }), META).oldPath.coverage).toBe(1);
    expect(buildComparison(makeAcc({ old: { rowsInActive: 5, expectedSlots: 0 } }), META).oldPath.coverage).toBeNull();
  });

  test('old-path uploads, uploadsPerSecond and request bytes', () => {
    const c = buildComparison(makeAcc({
      segmentMs: HOUR,
      rowsWithoutRecentFrames: 7,
      old: {
        rowsInActive: 1800, rowsOutsideActive: 200, gapsOver10s: 3, longestGapMs: 42_000,
        uploadJsonBytes: 3000, uploadsSized: 3,
      },
    }), META);
    expect(c.oldPath.uploads).toBe(2000);
    expect(c.oldPath.uploadsWhileActive).toBe(1800);
    expect(c.oldPath.uploadsOutsideActive).toBe(200);
    expect(c.oldPath.uploadsPerSecond).toBe(0.5);
    expect(c.oldPath.uploadsWithoutRecentFrames).toBe(7);
    expect(c.oldPath.gapsOver10s).toBe(3);
    expect(c.oldPath.longestGapMs).toBe(42_000);
    // average upload 1000 bytes × 1800 uploads while active, over 1 h (uploads outside activity excluded)
    expect(c.oldPath.requestBytesPerHour).toBe(1_800_000);
  });

  test('old-path request bytes and longest gap are null when unknown', () => {
    const c = buildComparison(makeAcc({ segmentMs: HOUR, old: { rowsInActive: 10 } }), META);
    expect(c.oldPath.requestBytesPerHour).toBeNull();
    expect(c.oldPath.longestGapMs).toBeNull();
  });

  test('parity numbers come from acc.tally', () => {
    const tally = new ParityTally();
    tally.add('soc', 'match', 0, 1, 1);
    tally.add('soc', 'mismatch', 0, 1, 2);
    tally.add('speed', 'match', 0, 3, 3);
    tally.add('speed', 'both-null', 0, null, null);
    const c = buildComparison(makeAcc({ tally, rowsCompared: 2 }), META);
    expect(c.parity.rowsCompared).toBe(2);
    expect(c.parity.compared).toBe(3);
    expect(c.parity.matchRate).toBeCloseTo(2 / 3, 12);
    expect(c.parity.worstFields.map((f) => f.field)).toEqual(['soc']);
  });

  test('worstFields keeps only mismatching fields, at most 10, worst first', () => {
    const tally = new ParityTally();
    for (let i = 0; i < 12; i++) {
      const field = `f${String(i).padStart(2, '0')}`;
      tally.add(field, 'mismatch', 0, 1, 2);
      for (let k = 0; k < i; k++) tally.add(field, 'match', 0, 1, 1);
    }
    tally.add('clean', 'match', 0, 1, 1);
    tally.add('empty', 'both-null', 0, null, null);
    const c = buildComparison(makeAcc({ tally }), META);
    expect(c.parity.worstFields).toHaveLength(10);
    expect(c.parity.worstFields.map((f) => f.field)).toEqual(
      ['f00', 'f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07', 'f08', 'f09'],
    );
    expect(c.parity.worstFields.every((f) => f.mismatches > 0)).toBe(true);
  });

  test('passes meta through and attaches targets and verdict', () => {
    const c = buildComparison(passingAcc({ windows: 3 }), { ...META, evccFixed: true });
    expect(c).toMatchObject({ vehicle: 'EV-0042', fromMs: META.fromMs, toMs: META.toMs, evccFixed: true, windows: 3 });
    expect(c.targets).toHaveLength(4);
    expect(c.verdict.decision).toBe('Adopt is supported by the data');
  });
});

describe('evaluateTargets and verdict', () => {
  const passOf = (c) => Object.fromEntries(c.targets.map((t) => [t.name, t.pass]));

  test('values exactly at the targets pass', () => {
    const c = buildComparison(passingAcc(), META);
    expect(c.activeHours).toBe(10);
    expect(c.newPath.missingRate).toBe(0.001);
    expect(c.newPath.lagP95Ms).toBe(750);
    expect(c.parity.matchRate).toBe(0.999);
    expect(c.targets.every((t) => t.pass === true)).toBe(true);
    expect(c.verdict).toEqual({
      decision: 'Adopt is supported by the data',
      reasons: expect.arrayContaining(['All trial targets are met.']),
    });
  });

  test('evaluateTargets is consistent when called directly', () => {
    const c = buildComparison(passingAcc(), META);
    expect(evaluateTargets(c)).toEqual(c.targets);
    expect(verdict(c)).toEqual(c.verdict);
  });

  test('not enough active hours, with no other failures', () => {
    const c = buildComparison(passingAcc({ segmentMs: 4.3 * HOUR }), META);
    expect(passOf(c)['Trial coverage']).toBe(false);
    expect(c.verdict.decision).toBe('Not enough data yet');
    expect(c.verdict.reasons).toEqual(['Only 4.3 active hours so far; the plan asks for 10.']);
  });

  test('not enough active hours lists failures already seen', () => {
    const c = buildComparison(passingAcc({
      segmentMs: 2 * HOUR,
      loss: [{ expected: 1000, missing: 2 }],
      tally: tallyWith(99, 1),
    }), META);
    expect(c.verdict.decision).toBe('Not enough data yet');
    expect(c.verdict.reasons[1]).toBe('Already failing: Frames lost (new path), Decoding parity with the app.');
  });

  test('not enough active hours takes precedence over unmeasurable targets', () => {
    const c = buildComparison(makeAcc(), META);
    expect(c.verdict.decision).toBe('Not enough data yet');
  });

  test('an unmeasurable target gives "Cannot judge"', () => {
    const c = buildComparison(passingAcc({ frameLag: [] }), META);
    expect(passOf(c)['Tablet → server delay p95 (new path)']).toBeNull();
    expect(c.verdict.decision).toBe('Cannot judge');
    expect(c.verdict.reasons).toEqual(['No measurement for: Tablet → server delay p95 (new path).']);
  });

  test('all targets unmeasurable except coverage lists each one', () => {
    const c = buildComparison(makeAcc({ segmentMs: 12 * HOUR }), META);
    expect(c.verdict.decision).toBe('Cannot judge');
    expect(c.verdict.reasons[0]).toBe(
      'No measurement for: Frames lost (new path), Tablet → server delay p95 (new path), Decoding parity with the app.',
    );
  });

  test('only parity failing suggests revising the decoder', () => {
    const c = buildComparison(passingAcc({ tally: tallyWith(998, 2) }), META);
    expect(passOf(c)['Decoding parity with the app']).toBe(false);
    expect(c.verdict.decision).toBe('Revise the decoder, then re-check');
  });

  test('frame loss failing suggests revising the transport', () => {
    const c = buildComparison(passingAcc({ loss: [{ expected: 1000, missing: 2 }] }), META);
    expect(passOf(c)['Frames lost (new path)']).toBe(false);
    expect(c.verdict.decision).toBe('Revise the transport, or drop');
    expect(c.verdict.reasons[0]).toBe('Failing: Frames lost (new path).');
  });

  test('latency failing (with parity) suggests revising the transport', () => {
    const c = buildComparison(passingAcc({ frameLag: lagWithP95(751), tally: tallyWith(10, 10) }), META);
    expect(passOf(c)['Tablet → server delay p95 (new path)']).toBe(false);
    expect(c.verdict.decision).toBe('Revise the transport, or drop');
    expect(c.verdict.reasons[0]).toBe('Failing: Tablet → server delay p95 (new path), Decoding parity with the app.');
  });
});

describe('renderComparison', () => {
  test('includes key headings, vehicle id and pass marks', () => {
    const md = renderComparison(buildComparison(passingAcc({ windows: 1 }), META));
    for (const h of ['## Suggested decision', '## Trial targets', '## Side by side', '## Parity', '## Not captured by the numbers']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('vehicle EV-0042');
    expect(md).toContain('(1 daily window)');
    expect(md).toContain('**Adopt is supported by the data.**');
    expect(md).toContain('| Trial coverage | ≥ 10 active hours | 10.0 h | Pass |');
    expect(md).toContain('| Frames lost (new path) | ≤ 0.1% | 0.100% | Pass |');
    expect(md).toContain('| Tablet → server delay p95 (new path) | ≤ 750 ms | 750 ms | Pass |');
    expect(md).not.toContain('**Fail**');
  });

  test('marks failures and shows a worst-field row with its example', () => {
    const md = renderComparison(buildComparison(passingAcc({ tally: tallyWith(3, 1) }), META));
    expect(md).toContain('| Decoding parity with the app | ≥ 99.9% | 75.000% | **Fail** |');
    expect(md).toContain('| Field | Match rate | Mismatches | Example (app → backend) |');
    expect(md).toContain('| soc | 75.000% | 1 | 50 → 51 at 2026-09-02T00:00:00.000Z |');
    expect(md).not.toContain('No mismatching fields.');
  });

  test('escapes pipes in examples', () => {
    const tally = new ParityTally();
    tally.add('mode', 'mismatch', 0, 'a|b', 'c');
    const md = renderComparison(buildComparison(passingAcc({ tally }), META));
    expect(md).toContain('"a\\|b" → "c"');
  });

  test('says "No mismatching fields." when parity is clean', () => {
    const md = renderComparison(buildComparison(passingAcc({ tally: tallyWith(10, 0) }), META));
    expect(md).toContain('No mismatching fields.');
  });

  test('all-zero accumulator renders dashes and no undefined/NaN', () => {
    const md = renderComparison(buildComparison(makeAcc(), META));
    expect(md).not.toMatch(/undefined|NaN|null/);
    expect(md).toContain('| Frames lost (new path) | ≤ 0.1% | – | – |');
    expect(md).toContain('| Tablet → server delay p95 (new path) | ≤ 750 ms | – | – |');
    expect(md).toContain('| Decoding parity with the app | ≥ 99.9% | – | – |');
    expect(md).toContain('| Trial coverage | ≥ 10 active hours | 0.0 h | **Fail** |');
    expect(md).toContain('| Delay to server | Not measurable | p50 – ms, p95 – ms |');
    expect(md).toContain('0 daily windows');
    expect(md).toContain('No mismatching fields.');
  });
});
