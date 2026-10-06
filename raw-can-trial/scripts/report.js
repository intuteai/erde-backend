#!/usr/bin/env node
// raw-can-trial/scripts/report.js
// Trial report for one vehicle and time window: loss, timing, volume, and parity
// between the app's uploads (live_values) and the state rebuilt from raw frames.
// Read-only. Run from the backend root (it reads DATABASE_URL from .env).
//
//   node raw-can-trial/scripts/report.js --vehicle 2 --from 2026-10-05T10:00+05:30 --to 2026-10-05T10:15+05:30 \
//        [--evcc-fixed] [--out report.md]
//
// Keep windows to a day or less: all frames in the window are held in memory.
// For the whole trial, use scripts/compare.js.
const fs = require('fs');
const db = require('../../config/postgres');
const { parseArgs, parseWindow } = require('./cli');
const {
  createAccumulator, collectWindow, toReport, loadColumns, tableBytes,
} = require('../trialMetrics');
const { renderMarkdown } = require('../analysis');

/** Builds the report object rendered by analysis.renderMarkdown(). */
const buildReport = async ({ vehicle, fromMs, toMs, evccFixed = false }) => {
  const columns = await loadColumns();
  const acc = createAccumulator();
  await collectWindow(acc, { vehicle, fromMs, toMs, evccFixed, columns });
  return toReport(acc, { vehicle, fromMs, toMs, evccFixed, tableBytes: await tableBytes() });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2), ['evcc-fixed']);
  const win = parseWindow(args);
  const report = await buildReport({ ...win, evccFixed: !!args['evcc-fixed'] });
  const markdown = renderMarkdown(report);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = args.out || `raw-can-report-v${win.vehicle}-${stamp}.md`;
  fs.writeFileSync(out, markdown, 'utf8');
  console.log(markdown.split('## Loss')[0].trim());
  console.log(`\nFull report written to ${out}`);
};

if (require.main === module) {
  main()
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.closePool());
}

module.exports = { buildReport };
