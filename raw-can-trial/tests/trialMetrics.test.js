// raw-can-trial/tests/trialMetrics.test.js
// Only the pure helper is tested here; collectWindow needs a database and is
// covered by the end-to-end check described in the README.
const { gapEndTimes, AFTER_LOSS_MS } = require('../trialMetrics');

const f = (sequence, receivedAtMs) => ({ sequence, receivedAtMs });

describe('gapEndTimes', () => {
  it('returns nothing when sequences are continuous', () => {
    expect(gapEndTimes([{ frames: [f(1, 10), f(2, 20), f(3, 30)] }])).toEqual([]);
  });

  it('returns the receive time of the first frame after each gap, across sessions, ascending', () => {
    const sessions = [
      { frames: [f(1, 100), f(2, 200), f(5, 500), f(6, 600), f(9, 900)] },
      { frames: [f(1, 300), f(3, 350)] },
    ];
    expect(gapEndTimes(sessions)).toEqual([350, 500, 900]);
  });

  it('uses a 5 s window after lost frames', () => {
    expect(AFTER_LOSS_MS).toBe(5000);
  });
});
