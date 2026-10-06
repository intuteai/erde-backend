// raw-can-trial/tests/config.test.js
const config = require('../config');

const KEYS = ['RAW_CAN_ENABLED', 'RAW_CAN_API_KEY', 'RAW_CAN_ALLOWED_PAIRS'];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('isEnabled', () => {
  it('is false when unset', () => {
    expect(config.isEnabled()).toBe(false);
  });

  it('is true only for the string "true"', () => {
    process.env.RAW_CAN_ENABLED = 'true';
    expect(config.isEnabled()).toBe(true);

    for (const v of ['TRUE', '1', 'yes', 'false', '']) {
      process.env.RAW_CAN_ENABLED = v;
      expect(config.isEnabled()).toBe(false);
    }
  });

  it('reads the environment on every call', () => {
    process.env.RAW_CAN_ENABLED = 'true';
    expect(config.isEnabled()).toBe(true);
    process.env.RAW_CAN_ENABLED = 'false';
    expect(config.isEnabled()).toBe(false);
  });
});

describe('apiKey', () => {
  it('returns an empty string when unset', () => {
    expect(config.apiKey()).toBe('');
  });

  it('returns the configured key', () => {
    process.env.RAW_CAN_API_KEY = 'abc123';
    expect(config.apiKey()).toBe('abc123');
  });
});

describe('allowedPairs', () => {
  it('is empty when unset', () => {
    expect(config.allowedPairs().size).toBe(0);
  });

  it('parses comma-separated pairs and trims spaces', () => {
    process.env.RAW_CAN_ALLOWED_PAIRS = ' 2:VCL001 , 3:VCL003 ';
    expect([...config.allowedPairs()].sort()).toEqual(['2:VCL001', '3:VCL003']);
  });

  it('ignores empty and malformed entries', () => {
    process.env.RAW_CAN_ALLOWED_PAIRS = '2:VCL001,,abc,:VCL9,0:VCL0,4:,x:VCL4';
    expect([...config.allowedPairs()]).toEqual(['2:VCL001']);
  });
});
