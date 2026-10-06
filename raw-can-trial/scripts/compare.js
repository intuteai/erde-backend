#!/usr/bin/env node
// raw-can-trial/scripts/compare.js
// Whole-trial comparison of the old path (app decodes, live_values) and the new
// path (raw CAN, backend decodes): side-by-side measures, trial targets and a
// suggested decision. Read-only. Run from the backend root (reads DATABASE_URL from .env).
//
//   node raw-can-trial/scripts/compare.js --vehicle 2 --from 2026-10-06T00:00+05:30 --to now \
//        [--evcc-fixed] [--chunk-hours 24] [--out comparison.md]
//
// The period is processed in chunks (24 h by default) so memory stays bounded.
// A frame gap that spans two chunks is not counted as loss.
const fs = require('fs');
const db = require('../../config/postgres');
const { parseArgs, parseWindow } = require('./cli');
const { createAccumulator, collectWindow, loadColumns } = require('../trialMetrics');
const { buildComparison, renderComparison } = require('../comparison');

/** Builds the comparison object rendered by comparison.renderComparison(). */
const buildTrialComparison = async ({ vehicle, fromMs, toMs, evccFixed = false, chunkHours = 24, onChunk }) => {
  const columns = await loadColumns();
  const acc = createAccumulator();
  const step = chunkHours * 3_600_000;
  for (let start = fromMs; start < toMs; start += step) {
    const end = Math.min(start + step, toMs);
    await collectWindow(acc, { vehicle, fromMs: start, toMs: end, evccFixed, columns });
    if (onChunk) onChunk(start, end, acc);
  }
  return buildComparison(acc, { vehicle, fromMs, toMs, evccFixed });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2), ['evcc-fixed']);
  const win = parseWindow(args);
  const chunkHours = args['chunk-hours'] ? Number(args['chunk-hours']) : 24;
  if (!(chunkHours > 0)) throw new Error('--chunk-hours must be a positive number');

  const comparison = await buildTrialComparison({
    ...win,
    evccFixed: !!args['evcc-fixed'],
    chunkHours,
    onChunk: (s, e, acc) => console.log(
      `processed ${new Date(s).toISOString()} → ${new Date(e).toISOString()}: ${acc.batches} batches, ${acc.appRows} app uploads so far`
    ),
  });
  const markdown = renderComparison(comparison);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = args.out || `raw-can-comparison-v${win.vehicle}-${stamp}.md`;
  fs.writeFileSync(out, markdown, 'utf8');
  console.log(`\n${markdown.split('## Side by side')[0].trim()}`);
  console.log(`\nFull comparison written to ${out}`);
};

if (require.main === module) {
  main()
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.closePool());
}

module.exports = { buildTrialComparison };
