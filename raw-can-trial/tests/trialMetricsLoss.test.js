// raw-can-trial/tests/trialMetricsLoss.test.js
// collectWindow with the database mocked: frame loss must be counted across
// windows, not inside each window (a whole-trial comparison runs in chunks).
jest.mock('../rawData');
jest.mock('../../config/postgres', () => ({ query: jest.fn(async () => ({ rows: [] })) }));

const { loadBatches } = require('../rawData');
const { createAccumulator, collectWindow } = require('../trialMetrics');

const SESSION = '9bbf8dd3-2db0-4e4c-a39f-488c919421d2';
let id = 0;
// A stored batch of consecutive frames, received by the server at serverMs.
const batch = (first, last, serverMs) => {
  const frames = [];
  for (let s = first; s <= last; s++) {
    frames.push({ sequence: s, receivedAtMs: serverMs - 500 + s, canId: 0x7ff, dataBase64: 'AA==' });
  }
  id += 1;
  return {
    batch_id: `b${id}`, session_id: SESSION, first_sequence: first, last_sequence: last,
    frame_count: frames.length, sent_at_ms: serverMs - 100, overlap: false, server_ms: serverMs, stored_bytes: 100, frames,
  };
};

const run = async (batches) => {
  loadBatches.mockResolvedValue(batches);
  const acc = createAccumulator();
  await collectWindow(acc, { vehicle: 2, fromMs: 0, toMs: 10_000, columns: new Map() });
  await collectWindow(acc, { vehicle: 2, fromMs: 10_000, toMs: 20_000, columns: new Map() });
  const missing = acc.loss.reduce((n, s) => n + s.missing, 0);
  const expected = acc.loss.reduce((n, s) => n + s.expected, 0);
  return { missing, expected, acc };
};

describe('collectWindow frame loss across windows', () => {
  it('counts a gap that crosses the boundary between two windows', async () => {
    // 1-3 arrive in the first window, 8-10 in the second: 4-7 are lost.
    const { missing, expected } = await run([batch(1, 3, 5_000), batch(8, 10, 15_000)]);
    expect(missing).toBe(4);
    expect(expected).toBe(10);
  });

  it('does not count frames as lost when their batch arrives in a later window', async () => {
    // 4-5 were queued on the tablet and arrive after 6-7: nothing is lost.
    const { missing, expected } = await run([batch(1, 3, 5_000), batch(6, 7, 6_000), batch(4, 5, 15_000)]);
    expect(missing).toBe(0);
    expect(expected).toBe(7);
  });

  it('keeps one merged run per stretch of frames, however many windows it spans', async () => {
    const { acc } = await run([batch(1, 3, 5_000), batch(4, 6, 6_000), batch(7, 9, 15_000), batch(12, 13, 16_000)]);
    expect(acc.seqRuns.get(SESSION)).toEqual([[1, 9], [12, 13]]);
  });

  it('counts a frame stored in both windows once', async () => {
    const { missing, expected, acc } = await run([batch(1, 5, 5_000), batch(5, 8, 15_000)]);
    expect(missing).toBe(0);
    expect(expected).toBe(8);
    expect(acc.loss).toHaveLength(1);
  });
});
