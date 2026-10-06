#!/usr/bin/env node
// raw-can-trial/scripts/replay.js
// Posts synthetic raw CAN batches to a running backend, to test the trial
// endpoint before a tablet sends anything. Use against local or test servers.
//
//   node raw-can-trial/scripts/replay.js --url http://localhost:5000 --key <RAW_CAN_API_KEY> \
//        --vehicle 2 --device VCL001 [--batches 10] [--frames 50] [--interval-ms 250] \
//        [--skip 120-129] [--duplicate 3] [--gzip]
//
//   --skip A-B      leave sequences A..B out, to create a gap the report must find
//   --duplicate N   send batch N twice with the same batchId (expect 202 then 200)
//   --gzip          gzip request bodies
const crypto = require('crypto');
const zlib = require('zlib');

// Real CAN ids from the trial spec, so a later decode exercises real decoders.
const CAN_IDS = [
  [0x141, false], [0x142, false], [0x143, false], [0x144, false], [0x145, false],
  [0x1800d08f, true], [0x18ffc13a, true], [0x18ff1ba6, true],
  [0xc08a6a7, true], [0xc09a6a7, true], [0xc0aa6a7, true],
];

const parseArgs = (argv) => {
  const args = { batches: 10, frames: 50, 'interval-ms': 250 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'gzip') args.gzip = true;
    else args[name] = argv[++i];
  }
  for (const required of ['url', 'key', 'vehicle', 'device']) {
    if (!args[required]) {
      console.error(`Missing --${required}. See the usage at the top of this file.`);
      process.exit(1);
    }
  }
  return args;
};

const makeFrame = (sequence, startMs, monoStart) => {
  const [canId, isExtended] = CAN_IDS[sequence % CAN_IDS.length];
  const payload = crypto.randomBytes(8);
  const now = Date.now();
  return {
    sequence,
    receivedAtMs: now,
    monotonicMs: monoStart + (now - startMs),
    canId,
    isExtended,
    dlc: payload.length,
    dataBase64: payload.toString('base64'),
    direction: 'rx',
    channel: 0,
  };
};

const send = async (args, batch) => {
  const json = JSON.stringify(batch);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': args.key,
    'x-idempotency-key': batch.batchId,
  };
  let body = json;
  if (args.gzip) {
    headers['content-encoding'] = 'gzip';
    body = zlib.gzipSync(json);
  }
  const res = await fetch(`${args.url.replace(/\/$/, '')}/api/telemetry/raw-can/v1`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const [skipFrom, skipTo] = args.skip ? args.skip.split('-').map(Number) : [null, null];
  const duplicateOf = args.duplicate ? Number(args.duplicate) : null;
  const sessionId = crypto.randomUUID();
  const startMs = Date.now();
  const monoStart = 1_000_000;

  console.log(`session ${sessionId}`);
  let sequence = 1;
  const counts = {};

  for (let n = 1; n <= Number(args.batches); n++) {
    const frames = [];
    while (frames.length < Number(args.frames)) {
      if (skipFrom !== null && sequence >= skipFrom && sequence <= skipTo) {
        sequence++;
        continue;
      }
      frames.push(makeFrame(sequence++, startMs, monoStart));
    }

    const batch = {
      schemaVersion: '1.0',
      vehicleMasterId: Number(args.vehicle),
      deviceId: args.device,
      sessionId,
      batchId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      firstSequence: frames[0].sequence,
      lastSequence: frames[frames.length - 1].sequence,
      frames,
    };

    const sends = n === duplicateOf ? 2 : 1;
    for (let s = 0; s < sends; s++) {
      const { status, text } = await send(args, batch);
      counts[status] = (counts[status] || 0) + 1;
      console.log(`batch ${n}${s ? ' (resend)' : ''} seq ${batch.firstSequence}-${batch.lastSequence}: ${status} ${text}`);
    }
    await new Promise((r) => setTimeout(r, Number(args['interval-ms'])));
  }

  console.log('responses by status:', JSON.stringify(counts));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
