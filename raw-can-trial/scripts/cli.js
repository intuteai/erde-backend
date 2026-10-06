// raw-can-trial/scripts/cli.js
// Small argument helpers shared by the trial's command-line scripts.

/** Parses "--name value" pairs; names listed in `flags` take no value. */
const parseArgs = (argv, flags = []) => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const name = a.slice(2);
    if (flags.includes(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  return args;
};

/** ISO date/time (e.g. 2026-10-02T09:00+05:30) or "now" → epoch ms. */
const parseTime = (value, name) => {
  if (value === 'now') return Date.now();
  const ms = Date.parse(value);
  if (!value || Number.isNaN(ms)) throw new Error(`--${name} must be an ISO date/time or "now", got "${value}"`);
  return ms;
};

/** Reads --vehicle, --from, --to and checks them. Default window: the last 24 hours. */
const parseWindow = (args) => {
  const vehicle = Number(args.vehicle);
  if (!Number.isSafeInteger(vehicle) || vehicle <= 0) throw new Error('--vehicle must be a vehicle_master_id');
  const toMs = args.to ? parseTime(args.to, 'to') : Date.now();
  const fromMs = args.from ? parseTime(args.from, 'from') : toMs - 24 * 3600_000;
  if (fromMs >= toMs) throw new Error('--from must be before --to');
  return { vehicle, fromMs, toMs };
};

module.exports = { parseArgs, parseTime, parseWindow };
