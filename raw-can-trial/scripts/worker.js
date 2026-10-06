#!/usr/bin/env node
// raw-can-trial/scripts/worker.js
// Decodes stored raw CAN batches into raw_can_decoded, and deletes old batches.
// Run from the backend root (it reads DATABASE_URL from .env).
//
//   node raw-can-trial/scripts/worker.js decode --vehicle 3 --from 2026-10-02T00:00+05:30 --to now [--evcc-fixed]
//   node raw-can-trial/scripts/worker.js purge --days 14
//
// decode: rebuilds the snapshots for that vehicle and window. Existing rows in the
//         window are replaced, so running it twice gives the same result.
// --evcc-fixed: decode EVCC frames as app builds that include the EVCC fix.
// purge:  deletes raw batches older than --days days. raw_can_decoded is kept.
const db = require('../../config/postgres');
const { parseArgs, parseWindow } = require('./cli');
const { loadBatches } = require('../rawData');
const { orderSessions, buildShadowSnapshots } = require('../stateAssembler');

const INSERT_CHUNK = 500;

/** @returns {Promise<{ batches: number, frames: number, snapshots: number, deleted: number }>} */
const decode = async ({ vehicle, fromMs, toMs, evccFixed = false }) => {
  const batches = await loadBatches(vehicle, fromMs, toMs);
  const { sessions } = orderSessions(batches);
  const snapshots = buildShadowSnapshots(sessions, { evccFixed })
    .filter((s) => s.recordedAtMs >= fromMs && s.recordedAtMs <= toMs);

  const client = await db.getClient();
  let deleted = 0;
  try {
    await client.query('BEGIN');
    const del = await client.query(
      `DELETE FROM raw_can_decoded
       WHERE vehicle_master_id = $1
         AND recorded_at >= to_timestamp($2 / 1000.0)
         AND recorded_at <= to_timestamp($3 / 1000.0)`,
      [vehicle, fromMs, toMs]
    );
    deleted = del.rowCount;

    for (let i = 0; i < snapshots.length; i += INSERT_CHUNK) {
      const chunk = snapshots.slice(i, i + INSERT_CHUNK).map((s) => ({
        t: s.recordedAtMs, s: s.sessionId, q: s.lastSequence, live: s.live,
      }));
      await client.query(
        `INSERT INTO raw_can_decoded (vehicle_master_id, recorded_at, session_id, last_sequence, live)
         SELECT $1, to_timestamp((x->>'t')::float8 / 1000.0), (x->>'s')::uuid, (x->>'q')::bigint, x->'live'
         FROM jsonb_array_elements($2::jsonb) AS x
         ON CONFLICT (vehicle_master_id, recorded_at) DO UPDATE
           SET session_id = EXCLUDED.session_id,
               last_sequence = EXCLUDED.last_sequence,
               live = EXCLUDED.live`,
        [vehicle, JSON.stringify(chunk)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    batches: batches.length,
    frames: sessions.reduce((n, s) => n + s.frames.length, 0),
    snapshots: snapshots.length,
    deleted,
  };
};

/** @returns {Promise<number>} batches deleted */
const purge = async ({ days }) => {
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a number, at least 1');
  const res = await db.query(
    `DELETE FROM raw_can_batches WHERE server_received_at < now() - ($1 * interval '1 day')`,
    [days]
  );
  return res.rowCount;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2), ['evcc-fixed']);
  const command = args._[0];

  if (command === 'decode') {
    const win = parseWindow(args);
    const r = await decode({ ...win, evccFixed: !!args['evcc-fixed'] });
    console.log(`vehicle ${win.vehicle}, ${new Date(win.fromMs).toISOString()} to ${new Date(win.toMs).toISOString()}`);
    console.log(`read ${r.batches} batches (${r.frames} frames, including warm-up); replaced ${r.deleted} rows with ${r.snapshots} snapshots`);
  } else if (command === 'purge') {
    const n = await purge({ days: Number(args.days) });
    console.log(`deleted ${n} raw batches older than ${args.days} days`);
  } else {
    console.error('Usage: worker.js decode --vehicle <id> [--from <time>] [--to <time>] [--evcc-fixed]\n'
      + '       worker.js purge --days <n>');
    process.exitCode = 1;
  }
};

if (require.main === module) {
  main()
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.closePool());
}

module.exports = { decode, purge };
