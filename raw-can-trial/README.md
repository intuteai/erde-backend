# Raw CAN shadow trial

A temporary, removable test of sending raw CAN frames from one tablet to the
backend and decoding them here, next to the existing decoded upload.

- Design: `docs/superpowers/specs/2026-09-30-raw-can-shadow-trial-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-10-01-raw-can-trial-phase1-ingest.md`

Everything for the trial is in this folder. Outside it, the only change is one
line in `app.js`. Nothing here writes to `live_values` or any existing table.

## What is in this folder

| Path | Purpose |
|---|---|
| `index.js` | `mount(app)`: route, its own 128 KiB JSON parser, 600/min rate limit, error handler |
| `config.js` | Reads the three `RAW_CAN_*` environment variables |
| `route.js` | `POST /api/telemetry/raw-can/v1` |
| `validateBatch.js` | Checks a batch against the v0.1 contract |
| `store.js` | Inserts a batch into `raw_can_batches` (duplicates and overlaps handled) |
| `decoders/` | CAN frame decoders ported from the app |
| `buildLiveValues.js` | Snapshot builder ported from the app |
| `freshness.js` | The app's freshness windows (300 s for every frame) |
| `stateAssembler.js` | Replays frames into the app's state, the way the app merges them |
| `rawData.js` | Loads stored batches for the worker and report |
| `analysis.js` | Loss, timing, volume and parity calculations, and the Markdown report |
| `scripts/worker.js` | Decodes stored batches into `raw_can_decoded`; deletes old batches |
| `scripts/report.js` | Writes the trial report for a vehicle and time window |
| `scripts/compare.js` | Whole-trial comparison of the old and new paths, with targets and a suggested decision |
| `trialMetrics.js` | Measurement code shared by the report and the comparison |
| `comparison.js` | Comparison calculations, targets, verdict and Markdown |
| `sql/create.sql`, `sql/remove.sql` | Create and drop the trial tables |
| `scripts/replay.js` | Sends synthetic batches to a running backend |
| `tests/` | Jest tests; none of them touch a database |

## Turning it on

1. Run `sql/create.sql` on the database. It creates `raw_can_batches` and
   `raw_can_decoded` and alters nothing else. It is safe to run twice.
2. Add to `.env` and restart:

   ```
   RAW_CAN_ENABLED=true
   RAW_CAN_API_KEY=<a new random key, not the production telemetry key>
   RAW_CAN_ALLOWED_PAIRS=2:VCL001     # trial vehicle: vehicle_master 2, VCU VCL001
   ```

   Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Check it with the replay tool:

   ```
   node raw-can-trial/scripts/replay.js --url https://analytics.erdeenergy.in \
        --key <RAW_CAN_API_KEY> --vehicle 2 --device VCL001 --batches 3 --frames 10
   ```

   Expect `202` responses. These test rows can be deleted afterwards with
   `DELETE FROM raw_can_batches WHERE session_id = '<session printed by the tool>';`.

While `RAW_CAN_ENABLED` is anything other than `true`, the route answers 503 and
does nothing else.

## Decoding and reporting

Run from the backend root, on a machine that can reach the database (both read
`DATABASE_URL` from `.env`). Times are ISO, e.g. `2026-10-02T09:00+05:30`, or `now`;
without `--from`/`--to` the window is the last 24 hours.

```
# Report: loss, timing, volume and parity against the app's uploads (read-only)
node raw-can-trial/scripts/report.js --vehicle 2 --from 2026-10-02T08:00+05:30 --to 2026-10-02T18:00+05:30 --out /tmp/report.md

# Whole trial: old path vs new path, targets and a suggested decision (read-only)
node raw-can-trial/scripts/compare.js --vehicle 2 --from 2026-10-06T00:00+05:30 --to now --evcc-fixed --out /tmp/comparison.md

# Shadow output: fill raw_can_decoded for a window (replaces rows already there)
node raw-can-trial/scripts/worker.js decode --vehicle 2 --from 2026-10-02T08:00+05:30 --to now

# Housekeeping: delete raw batches older than 14 days
node raw-can-trial/scripts/worker.js purge --days 14
```

- **Parity method.** The report does not need the worker. For every app upload
  in `live_values`, it rebuilds the state from raw frames at the same tablet time
  (both come from the tablet clock) and compares field by field. Numbers match
  within half a unit of the column's stored precision. Uploads with no raw frame
  in the 2 s before them are counted separately rather than compared.
- **EVCC.** Add `--evcc-fixed` to both scripts for app builds that include the
  EVCC fix (see the app team guide). Without it, the decoder reproduces today's
  app, where two EVCC frames fail to decode.
- **Window size.** Keep report windows to a day or less, since all frames in the
  window are held in memory. `compare.js` handles long periods by working through
  them a day at a time (`--chunk-hours` to change). Use `--out` to write outside the repo.
- **Comparison basis.** The vehicle counts as active while the raw path sees CAN
  frames no more than 10 s apart; both paths are measured per active hour. The
  old path's delay to the server cannot be measured: `live_values` has no
  server-receive time.

## Tests

```
npx jest --runTestsByPath $(find raw-can-trial/tests -name "*.test.js")
```

Run only this folder's tests: `tests/auth.test.js` in the repo uses a real database.
The explicit paths matter inside OneDrive: OneDrive turns files into cloud
placeholders that Jest's crawler skips, so `npx jest raw-can-trial` can silently
miss test files.

## Removing the trial

1. Set `RAW_CAN_ENABLED` to anything but `true` and restart.
2. Run `sql/remove.sql` (drops both trial tables and all trial data; export first if needed).
3. Delete this folder and the line in `app.js` that calls `require('./raw-can-trial').mount(app)`.
4. Remove the three `RAW_CAN_*` lines from `.env`.
5. The app team turns off or removes the raw uploader.

After step 3 the backend code is the same as before the trial.
