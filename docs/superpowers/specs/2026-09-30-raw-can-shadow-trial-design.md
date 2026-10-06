# Raw CAN shadow trial: backend design

Date: 2026-09-30
Status: draft for review
Based on: "Raw CAN to Cloud: Backend Ingestion Workflow & Data Contract", proposed v0.1 (app team)

## Goal

Find out whether sending raw CAN frames to the cloud and decoding them on the
backend is worth adopting, by running it on one vehicle next to the existing
path and comparing the two.

The trial must answer four questions:

1. **Loss:** do all frames the tablet receives reach the backend?
2. **Timing:** how long does a frame take from tablet to backend?
3. **Volume:** how many frames per second, how much data and storage per day?
4. **Parity:** does a backend decoder produce the same values the app uploads today?

## Constraints

- The existing path is not modified: `POST /api/telemetry`, the `live_values`
  table, the SSE streams, the dashboard, and the app's decoded upload all stay
  as they are and remain what the dashboard reads.
- The trial runs on the production backend and production database.
- Every change is additive and can be switched off without a deploy.
- The trial vehicle is not chosen yet. It is configuration, not code.

## Production database facts (checked 2026-09-30, read-only)

- `live_values` holds about 10.5 million rows in 21 GB. Active vehicles add
  roughly 23,000–30,000 rows a day each, one every 2 seconds while running.
- `live_values` has three `AFTER INSERT` triggers. They write `dtc_events` and
  update `vehicle_latest_snapshot`. Anything inserted into `live_values` shows
  up as faults and as the latest dashboard state, so the trial must never
  insert there. This is why decoded output goes to its own table.
- `live_values` has no unique key on `(vehicle_master_id, recorded_at)`. No
  duplicate timestamps exist in the last 3 days.
- Seven vehicles are registered. Vehicles 1, 3, 6 and 7 sent data on all of the
  last 8 days. Vehicle 2, the one hardcoded in the app repo that was reviewed,
  sent 687 rows on one day. A daily-running vehicle gives a more useful trial.

## Out of scope

- Feeding backend-decoded values to the dashboard.
- Live, in-process decoding and the contract's decode-latency target.
- Object storage for raw frames.
- Fixing the quirks in the app's decoding (see "Known quirks copied on purpose").
- Running hours, trip hours and kWh. The tablet computes these; they cannot be
  rebuilt from CAN frames.
- GPIO, ADC and KTY values. These arrive as non-CAN BLE frame types and are not
  part of the raw contract.

## Overview

```
Tablet ──POST raw batch──▶ raw-can-trial/route.js ──▶ raw_can_batches   (production process)

raw_can_batches ──▶ raw-can-trial/scripts/worker.js ──▶ raw_can_decoded   (separate process, on demand)

raw_can_batches + raw_can_decoded + live_values ──▶ raw-can-trial/scripts/report.js ──▶ report
```

The production process only validates and stores batches. Decoding and analysis
run as separate scripts, so a decoder bug cannot affect the live server and any
time window can be decoded again after a fix.

## Configuration

New entries in `.env`. None of the existing entries change.

| Variable | Meaning | Value when unset |
|---|---|---|
| `RAW_CAN_ENABLED` | Kill switch. `true` enables the route. | off |
| `RAW_CAN_API_KEY` | Test-only key for the raw route. Must differ from `TELEMETRY_API_KEY`. | route rejects every request |
| `RAW_CAN_ALLOWED_PAIRS` | Comma-separated `vehicleMasterId:deviceId` pairs allowed to send, for example `2:VCL001`. | no vehicle allowed |

Choosing or changing the trial vehicle means editing `RAW_CAN_ALLOWED_PAIRS`
and restarting. No code change.

## Component 1: ingest endpoint

### Files

All paths below are inside `raw-can-trial/`.

- `index.js`: `mount(app)`, the only thing `app.js` calls.
- `config.js`: reads the three `.env` entries at request time.
- `raw-can-trial/route.js`: the route handler.
- `raw-can-trial/validateBatch.js`: a pure function that checks a parsed body
  and returns either the normalised batch or an error with a reason.
- `raw-can-trial/store.js`: the insert and the duplicate lookup.
- `app.js`: one added line (see "Mounting").

### Mounting

Everything for the trial lives in one folder, `raw-can-trial/`, so it can be
removed by deleting that folder. `raw-can-trial/index.js` exports
`mount(app)`, which registers the route with its own body parser, rate limiter
and error handler:

```js
app.use(
  '/api/telemetry/raw-can',
  rawCanLimiter,
  express.json({ limit: '128kb' }),
  router,
  errorHandler
);
```

`app.js` gets one added line, placed after the CORS middleware and **before**
the global `express.json({ limit: '10mb' })`:

```js
require('./raw-can-trial').mount(app); // raw CAN shadow trial; remove with raw-can-trial/
```

- `rawCanLimiter` is `rateLimiter({ windowMs: 60_000, max: 600, keyPrefix: 'rawcan' })`
  from the existing factory in `middleware/rateLimiter.js`. At the contract's
  250–500 ms flush a tablet sends 120–240 requests a minute, which would exceed
  the shared `generalLimiter` (200 a minute).
- The 128 KiB limit applies to the body after gzip is inflated, so an oversized
  batch gets 413 from the parser. Gzip request bodies need no extra code.
- `errorHandler` turns parser errors (oversized or malformed body) into the
  trial's own JSON response instead of the app's generic error handler.
- Because this mount comes first and handles the request, the existing
  `/api/telemetry` mount and its limiter are never reached for raw requests.

### Request handling

`POST /api/telemetry/raw-can/v1`, in this order:

1. If `RAW_CAN_ENABLED` is not `true`: 503.
2. Compare `x-api-key` with `RAW_CAN_API_KEY` using a timing-safe comparison: 401 on mismatch.
3. Validate the body (rules below): 400 with a `reason` string on failure.
4. Check that `vehicleMasterId:deviceId` is in `RAW_CAN_ALLOWED_PAIRS`: 403 if not.
5. Insert the batch. If `batchId` already exists: 200 with `duplicate: true`
   and the stored `ackSequence`.
6. Otherwise reply 202 after the insert has committed.

### Validation rules

- `schemaVersion` is `"1.0"`.
- `vehicleMasterId` is a positive integer; `deviceId` is a non-empty string.
- `sessionId` and `batchId` are UUIDs.
- If the `x-idempotency-key` header is present it equals `batchId`.
- `sentAtMs`, `firstSequence`, `lastSequence` are non-negative integers.
- `frames` is an array of 1 to 200 items.
- For each frame:
  - `sequence` is an integer, strictly greater than the previous frame's.
  - `receivedAtMs` and `monotonicMs` are non-negative integers.
  - `canId` is an integer in `0..0x7FF` when `isExtended` is false, `0..0x1FFFFFFF` when true.
  - `dlc` is an integer 0 to 8.
  - `dataBase64` decodes to exactly `dlc` bytes.
  - `direction` is `rx` or `tx`; `channel` is a non-negative integer.
- `firstSequence` equals the first frame's `sequence`; `lastSequence` equals the last frame's.

Unknown CAN ids are valid and stored. Clock skew in `receivedAtMs` is not a
reason to reject; it is recorded and reported.

### Responses

| Status | When | Body |
|---|---|---|
| 202 | New batch stored | `accepted: true, batchId, acceptedFrames, ackSequence, serverReceivedAtMs, status: "stored"` |
| 200 | `batchId` already stored | same fields plus `duplicate: true` |
| 400 | Validation failure or malformed JSON | `accepted: false, reason` |
| 401 | Missing or wrong key | `error` |
| 403 | Vehicle/device pair not allowed | `error` |
| 413 | Body over 128 KiB | from the body parser |
| 429 | Rate limited | existing limiter response with `Retry-After` |
| 503 | Kill switch off | `error` |
| 500 | Database failure | `error` |

### Difference from the v0.1 contract

The contract returns 409 for a sequence or session conflict. The trial does not.
A batch whose sequence range overlaps an already stored batch of the same
session, under a different `batchId`, is stored with `overlap = true` and
acknowledged normally. The worker drops duplicate frames when it reads. The
report counts overlaps, which shows whether 409 handling is needed at all.

## Component 2: database

Two SQL files, run by hand: `raw-can-trial/sql/create.sql` creates two tables
and alters nothing that exists; `raw-can-trial/sql/remove.sql` drops them.

```sql
CREATE TABLE raw_can_batches (
  batch_id            uuid PRIMARY KEY,
  vehicle_master_id   integer     NOT NULL,
  device_id           text        NOT NULL,
  session_id          uuid        NOT NULL,
  first_sequence      bigint      NOT NULL,
  last_sequence       bigint      NOT NULL,
  frame_count         integer     NOT NULL,
  sent_at_ms          bigint      NOT NULL,
  server_received_at  timestamptz NOT NULL DEFAULT now(),
  overlap             boolean     NOT NULL DEFAULT false,
  frames              jsonb       NOT NULL
);

CREATE INDEX raw_can_batches_vehicle_time_idx
  ON raw_can_batches (vehicle_master_id, server_received_at);

CREATE INDEX raw_can_batches_session_seq_idx
  ON raw_can_batches (device_id, session_id, first_sequence);

CREATE TABLE raw_can_decoded (
  vehicle_master_id   integer     NOT NULL,
  recorded_at         timestamptz NOT NULL,
  session_id          uuid        NOT NULL,
  last_sequence       bigint      NOT NULL,
  live                jsonb       NOT NULL,
  PRIMARY KEY (vehicle_master_id, recorded_at)
);
```

- `frames` holds the frame array as received.
- `raw_can_decoded.live` holds one decoded snapshot using the same keys the app
  sends in its `live` object. A single JSON column avoids a second 114-column
  table and does not depend on the exact `live_values` definition.

## Removal

If the trial is not adopted, everything it added is removed in five steps:

1. Set `RAW_CAN_ENABLED` to anything but `true` and restart.
2. Run `raw-can-trial/sql/remove.sql`.
3. Delete the `raw-can-trial/` folder and the one line in `app.js`.
4. Remove the three `RAW_CAN_*` lines from `.env`.
5. The app team turns off or removes the raw uploader.

After step 3 the backend code is identical to before the trial.

## Component 3: decoder worker

### Files

- `raw-can-trial/decoders/`: one file per device family (`bms.js`, `motor.js`,
  `dcdc.js`, `btms.js`, `evcc.js`, `airPump.js`, `imd.js`, `vcu.js`) and an
  `index.js` that maps a CAN id to its decoder. Each decoder is a pure function
  from a `Buffer` to an object, ported from
  `services/BatteryBluetoothProvider.tsx` in the app at commit `d76659a`.
- `raw-can-trial/stateAssembler.js`: merges decoded frames into a per-vehicle
  state and emits snapshots.
- `raw-can-trial/buildLiveValues.js`: port of the app's
  `src/telemetry/buildLiveValues.ts`, turning the state into a `live` object.
- `raw-can-trial/freshness.js`: the stale thresholds per CAN id, in one place.
- `raw-can-trial/scripts/worker.js`: the command-line entry point.

### CAN ids decoded

The same set the app handles: `0x140`–`0x154`, `0x1819A1A4`, `0x1800D08F`,
`0x1801D08F`, `0x142CFF27`, `0x18FFC13A`, `0x18FF45F4`, `0x18FF1BA6`,
`0x18FF1CA6`, `0x1011F456`, `0x1819F456`, `0x181DF456`, `0xC08A6A7`,
`0xC09A6A7`, `0xC0AA6A7`. Any other id is counted as unknown and skipped.

### Assembly rules

- Frames are read for one vehicle and a time window, grouped by session, and
  ordered by `sequence`. Sessions are ordered by their first `receivedAtMs`.
- A frame whose `(session, sequence)` has already been seen is dropped.
- Each frame updates only the signals its CAN id carries, and its id's last-seen time.
- Time is the tablet's `receivedAtMs`.
- A snapshot is emitted at each 2-second boundary of tablet time in which at
  least one frame arrived. This matches the app's 2-second upload cadence.
- A signal whose CAN id was last seen longer ago than its threshold is emitted as null.

### Commands

- `node raw-can-trial/scripts/worker.js decode --vehicle <id> --from <iso> --to <iso>`
  deletes `raw_can_decoded` rows for that vehicle and window, then decodes and
  writes them again. Running it twice gives the same result.
- `node raw-can-trial/scripts/worker.js purge --days 14` deletes raw batches older than
  the given number of days. Nothing is deleted unless this is run.

### Known quirks copied on purpose

The first decoder reproduces the app's behaviour exactly, so that a mismatch in
the report means a transport or porting error and nothing else:

- every freshness threshold is 300 seconds;
- `mcu_enable_state` is derived from battery status, not from the MCU enable bit;
- `motor_status_word` is "Running" or "Stopped";
- BMS state 1 (READY) is reported as "OFF";
- `cell_modules` and `temp_modules` are all-null grids of 8×24 and 8×18.

Correcting these is a separate decision after the trial.

## Component 4: analysis report

`node raw-can-trial/scripts/report.js --vehicle <id> --from <iso> --to <iso>` prints a
report and writes it as a Markdown file.

- **Loss:** per session, the expected frame count (`max − min + 1` of sequence)
  against the distinct frames stored, and each gap's range.
- **Duplicates:** duplicate batch requests are not stored, so the report counts
  overlapping batches and duplicate frames dropped by the worker.
- **Timing:** `server_received_at − receivedAtMs` per frame, p50, p95 and max.
  The report also prints `server_received_at − sentAtMs` per batch; a large or
  negative value there means the tablet clock is off and the timing figures
  should not be trusted.
- **Volume:** frames per second overall and per CAN id, unknown ids, batches per
  minute, and the stored size of `raw_can_batches` per day.
- **Parity:** for each `live_values` row for the vehicle in the window, the
  report rebuilds the state from raw frames at that row's exact tablet time
  (both timestamps come from the tablet clock) and compares the two. This
  replaced the original "nearest `raw_can_decoded` row within 2 seconds" rule,
  which would have mixed timing differences into the parity figure. Rows with no
  raw frame in the 2 seconds before them are counted separately. For each field the report
  gives the number compared, the match rate and up to five example mismatches.
  Numbers are compared after rounding to the precision the app uses. Excluded
  fields: `total_running_hrs`, `last_trip_hrs`, `total_kwh_consumed`,
  `last_trip_kwh`.
- **Unmatched rows:** `live_values` rows with no shadow row within 2 seconds are
  counted separately. A high count means the app uploaded snapshots during
  periods when no frames arrived.

## Testing

- **Validator:** unit tests for every rule, one accepted case and one rejected
  case each.
- **Route:** `supertest` tests in the existing Jest setup for 202, duplicate 200,
  400, 401, 403, 413 and 503.
- **Decoders:** unit tests per CAN id. Expected values are worked out from the
  app's parser code for hand-built byte patterns, including signed values,
  "not available" markers such as `0xFF`, and short payloads.
- **Assembler:** tests for ordering, duplicate frames, staleness nulling and the
  2-second emission rule, with a fixed list of frames as input.
- **Replay script:** `raw-can-trial/scripts/replay.js` posts synthetic batches to a
  running backend, with options to retry a batch, resend a duplicate and skip
  sequences. It is used locally before the tablet sends anything, and to check
  the report's loss figures against a known gap.

## Build order

1. SQL file, validator, store, route, `app.js` mount, replay script and their
   tests. After this is deployed with the switch on, the app team can send.
2. Decoders, assembler, `buildLiveValues` port and the worker.
3. Report script.

Work happens on a branch, not on `main`: a push to `main` triggers the image
build. `routes/vehicle.js` has an unrelated uncommitted change that this work
leaves alone.

## What the app team needs from the backend

- The URL: `https://analytics.erdeenergy.in/api/telemetry/raw-can/v1`.
- The test key, sent out of band.
- Limits: 200 frames, 128 KiB after inflation, 600 requests a minute.
- The response table above, including the 409 difference.
- Confirmation that the existing decoded upload must stay enabled on the trial vehicle.

## Before the trial starts

- Pick the vehicle and set `RAW_CAN_ALLOWED_PAIRS`.
- Generate `RAW_CAN_API_KEY` and add it to the production `.env`.
- Run `raw-can-trial/sql/create.sql` on the production database.
