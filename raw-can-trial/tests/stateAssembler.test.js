// raw-can-trial/tests/stateAssembler.test.js
const {
  StateAssembler, mergeDecoded, orderSessions, buildShadowSnapshots, snapshotsAt, forEachWindow,
} = require('../stateAssembler');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const b64 = (s) => hex(s).toString('base64');

const SOC_80 = '1F40 2710 0064 0102'; // 0x142: SOC 80, SOH 100, 100 cycles
const SOC_60 = '1770 2710 0064 0102'; // 0x142: SOC 60
const T0 = 1_790_000_000_000; // a round tablet time, multiple of 2000

const frame = (sequence, receivedAtMs, canId, payloadHex) => ({
  sequence,
  receivedAtMs,
  canId,
  payload: hex(payloadHex),
});

describe('StateAssembler', () => {
  it('starts empty: nothing fresh, no battery values', () => {
    const asm = new StateAssembler();
    const live = asm.snapshot(T0);
    expect(live.soc_percent).toBeNull();
    expect(live.battery_status).toBeNull();
    expect(live.mcu_enable_state).toBe('mcu_disabled');
  });

  it('decodes a frame into the uploaded snapshot', () => {
    const asm = new StateAssembler();
    expect(asm.apply(frame(1, T0, 0x142, SOC_80))).toBe(true);
    const live = asm.snapshot(T0 + 1000);
    expect(live.soc_percent).toBe(80);
    expect(live.soh_percent).toBe(100);
    expect(live.cycle_count).toBe(100);
  });

  it('keeps values fresh for 300 s after the frame, then nulls them', () => {
    const asm = new StateAssembler();
    asm.apply(frame(1, T0, 0x142, SOC_80));
    expect(asm.snapshot(T0 + 299_999).soc_percent).toBe(80);
    expect(asm.snapshot(T0 + 300_000).soc_percent).toBeNull();
  });

  it('a later frame of the same id replaces the value', () => {
    const asm = new StateAssembler();
    asm.apply(frame(1, T0, 0x142, SOC_80));
    asm.apply(frame(2, T0 + 500, 0x142, SOC_60));
    expect(asm.snapshot(T0 + 600).soc_percent).toBe(60);
  });

  it('ignores ids the app does not decode', () => {
    const asm = new StateAssembler();
    expect(asm.apply(frame(1, T0, 0x7ff, '00'))).toBe(false);
    expect(asm.data).toEqual({});
  });

  it('merges DCDC input and output from their two frames, as the app does', () => {
    const asm = new StateAssembler();
    asm.apply(frame(1, T0, 0x1800d08f, '01 8100 8813 32 05 7B'));
    asm.apply(frame(2, T0 + 10, 0x1801d08f, 'E803 2C01 64 0000 09'));
    const vc = asm.data.dcdcVtgCur;
    expect(Object.keys(vc).sort()).toEqual(['Input_Current', 'Input_Voltage', 'Output_Current', 'Output_Voltage']);
    expect(vc.Input_Voltage).toBe(asm.data.dcdcStatus1.inputVoltageV);
    expect(vc.Output_Voltage).toBe(asm.data.dcdcStatus2.outputVoltageV);
  });

  it('reproduces the EVCC parsing failure by default and decodes with evccFixed', () => {
    const payload = '0102030405060708';
    const buggy = new StateAssembler();
    buggy.apply(frame(1, T0, 0x1011f456, payload));
    expect(buggy.data.evcc.control).toEqual({});
    expect(buggy.data.parsingError).toBeDefined();

    const fixed = new StateAssembler({ evccFixed: true });
    fixed.apply(frame(1, T0, 0x1011f456, payload));
    expect(Object.keys(fixed.data.evcc.control).length).toBeGreaterThan(0);
  });

  it('reset() clears state and freshness', () => {
    const asm = new StateAssembler();
    asm.apply(frame(1, T0, 0x142, SOC_80));
    asm.reset();
    expect(asm.data).toEqual({});
    expect(asm.snapshot(T0 + 10).soc_percent).toBeNull();
  });
});

describe('mergeDecoded', () => {
  it('merges nested EVCC sections without losing the other sections', () => {
    let s = mergeDecoded({}, { evcc: { evseLimits: { a: 1 } } });
    s = mergeDecoded(s, { evcc: { control: { b: 2 } } });
    expect(s.evcc.evseLimits).toEqual({ a: 1 });
    expect(s.evcc.control).toEqual({ b: 2 });
  });

  it('merges motorBasic fields from different motor frames', () => {
    let s = mergeDecoded({}, { motorBasic: { rpm: 100 } });
    s = mergeDecoded(s, { motorBasic: { motorTempC: 40 } });
    expect(s.motorBasic).toEqual({ rpm: 100, motorTempC: 40 });
  });
});

describe('orderSessions', () => {
  const stored = (sequence, receivedAtMs) => ({
    sequence, receivedAtMs, monotonicMs: 0, canId: 0x142, isExtended: false,
    dlc: 8, dataBase64: b64(SOC_80), direction: 'rx', channel: 0,
  });

  it('orders frames by sequence, removes duplicates and orders sessions by first frame', () => {
    const { sessions, duplicateFrames } = orderSessions([
      { session_id: 'B', frames: [stored(1, T0 + 50_000)] },
      { session_id: 'A', frames: [stored(3, T0 + 3), stored(4, T0 + 4)] },
      { session_id: 'A', frames: [stored(1, T0 + 1), stored(2, T0 + 2)] },
      { session_id: 'A', frames: [stored(2, T0 + 2), stored(3, T0 + 3)] }, // overlap
    ]);
    expect(sessions.map((s) => s.sessionId)).toEqual(['A', 'B']);
    expect(sessions[0].frames.map((f) => f.sequence)).toEqual([1, 2, 3, 4]);
    expect(duplicateFrames).toBe(2);
    expect(Buffer.isBuffer(sessions[0].frames[0].payload)).toBe(true);
  });
});

describe('buildShadowSnapshots', () => {
  it('emits one snapshot at the end of each 2 s window that had frames', () => {
    const sessions = [{
      sessionId: 'S',
      frames: [
        frame(1, T0 + 100, 0x142, SOC_80),
        frame(2, T0 + 1900, 0x142, SOC_80),
        frame(3, T0 + 2500, 0x142, SOC_60),
        frame(4, T0 + 9000, 0x142, SOC_80), // windows 4000-8000 had no frames
      ],
    }];
    const out = buildShadowSnapshots(sessions);
    expect(out.map((s) => s.recordedAtMs - T0)).toEqual([2000, 4000, 10000]);
    expect(out.map((s) => s.lastSequence)).toEqual([2, 3, 4]);
    expect(out.map((s) => s.live.soc_percent)).toEqual([80, 60, 80]);
    expect(out[0].sessionId).toBe('S');
  });

  it('starts each session from empty state', () => {
    const out = buildShadowSnapshots([
      { sessionId: 'A', frames: [frame(1, T0 + 100, 0x142, SOC_80)] },
      { sessionId: 'B', frames: [frame(1, T0 + 5100, 0x143, '07D0 0FA0 3A98 FF9C')] },
    ]);
    expect(out[0].live.soc_percent).toBe(80);
    expect(out[1].live.soc_percent).toBeNull(); // session B never saw 0x142
    expect(out[1].live.stack_voltage_v).toBe(750);
  });
});

describe('snapshotsAt', () => {
  const sessions = [
    { sessionId: 'A', frames: [frame(1, T0 + 100, 0x142, SOC_80), frame(2, T0 + 3000, 0x142, SOC_60)] },
    { sessionId: 'B', frames: [frame(1, T0 + 10_000, 0x143, '07D0 0FA0 3A98 FF9C')] },
  ];

  it('returns the state at each moment from frames received by then', () => {
    const out = snapshotsAt(sessions, [T0, T0 + 2000, T0 + 3000, T0 + 9000, T0 + 10_500]);
    expect(out[0].live).toBeNull(); // before the first frame
    expect(out[1].live.soc_percent).toBe(80);
    expect(out[2].live.soc_percent).toBe(60); // a frame at exactly t counts
    expect(out[3].live.soc_percent).toBe(60);
    expect(out[3].lastFrameAtMs).toBe(T0 + 3000);
    expect(out[4].live.soc_percent).toBeNull(); // session B started from empty state
    expect(out[4].live.stack_voltage_v).toBe(750);
  });
});

describe('forEachWindow', () => {
  const sessions = [{
    sessionId: 'A',
    frames: [
      frame(1, T0 + 100, 0x142, SOC_80),
      frame(2, T0 + 1500, 0x142, SOC_60),
      frame(3, T0 + 1800, 0x142, SOC_80),
    ],
  }];

  it('gives the state at the window start plus the state after each frame in the window', () => {
    const seen = [];
    forEachWindow(sessions, [T0 + 2000], 1000, {}, (i, m) => seen.push({ i, m }));
    expect(seen).toHaveLength(1);
    const { m } = seen[0];
    expect(m.candidates.map((c) => c.soc_percent)).toEqual([80, 60, 80]);
    expect(m.live.soc_percent).toBe(80);
    expect(m.lastFrameAtMs).toBe(T0 + 1800);
  });

  it('reports moments before the first session with null state', () => {
    const seen = [];
    forEachWindow(sessions, [T0, T0 + 3000], 1000, {}, (i, m) => seen.push(m));
    expect(seen[0].live).toBeNull();
    expect(seen[0].candidates).toBeNull();
    expect(seen[1].candidates.map((c) => c.soc_percent)).toEqual([80]); // no frames in (2000, 3000]
  });
});
