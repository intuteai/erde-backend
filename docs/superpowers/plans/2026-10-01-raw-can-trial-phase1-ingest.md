# Raw CAN Trial, Phase 1 (Ingest) Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept raw CAN batches from one tablet at `POST /api/telemetry/raw-can/v1`, validate them, store one row per batch, and acknowledge, without changing any existing behaviour.

**Architecture:** Everything lives in `raw-can-trial/`. `app.js` gets one line, `require('./raw-can-trial').mount(app)`, placed before the global JSON parser. The route has its own body parser (128 KiB), rate limiter (600 a minute), kill switch and error handler. Storage is a new table, `raw_can_batches`. Spec: `docs/superpowers/specs/2026-09-30-raw-can-shadow-trial-design.md`.

**Tech stack:** Node 20+, Express 4.21, pg 8, Jest 30, supertest 7. No new dependencies.

**Repo rules:** Nothing is committed or pushed (Rahul commits manually), so there are no commit steps. Tests must never write to the production database: route tests mock `store.js`, and only the trial's own tests are run (`npx jest raw-can-trial`); `tests/auth.test.js` hits a real database and is not run.

**Phases 2 and 3** (decoders, worker, report) get their own plans once this phase is deployed and real frames exist.

---

## File map

| File | Responsibility |
|---|---|
| `raw-can-trial/config.js` | Reads `RAW_CAN_ENABLED`, `RAW_CAN_API_KEY`, `RAW_CAN_ALLOWED_PAIRS` at call time |
| `raw-can-trial/validateBatch.js` | Pure function: body and headers in, normalised batch or rejection reason out |
| `raw-can-trial/store.js` | `insertBatch(batch, receivedAtMs)`: insert with duplicate and overlap detection |
| `raw-can-trial/route.js` | Express router, `POST /v1`, order of checks from the spec |
| `raw-can-trial/index.js` | `mount(app)`: limiter, parser, router, error handler |
| `raw-can-trial/sql/create.sql` | Creates `raw_can_batches` and `raw_can_decoded` with indexes |
| `raw-can-trial/sql/remove.sql` | Drops both tables |
| `raw-can-trial/scripts/replay.js` | Posts synthetic batches to a running backend |
| `raw-can-trial/README.md` | Enable, test, remove |
| `raw-can-trial/tests/*.test.js` | Validator, route and mount tests |
| `app.js` | One added line |

---

### Task 1: Configuration reader

**Files:** create `raw-can-trial/config.js`; test `raw-can-trial/tests/config.test.js`.

- [ ] Write tests: `isEnabled()` is true only for the string `true`; `apiKey()` returns `''` when unset; `allowedPairs()` parses `" 2:VCL001 , 3:VCL003 "` into a `Set` of `2:VCL001` and `3:VCL003`, ignores empty and malformed entries, and returns an empty set when unset.
- [ ] Run `npx jest raw-can-trial/tests/config.test.js`; expect failure (module missing).
- [ ] Implement the three functions reading `process.env` on every call.
- [ ] Run the test again; expect pass.

### Task 2: Batch validator

**Files:** create `raw-can-trial/validateBatch.js`; test `raw-can-trial/tests/validateBatch.test.js`.

`validateBatch(body, headers)` returns `{ ok: true, batch }` or `{ ok: false, reason }`.

- [ ] Write one passing test for a valid batch (the spec's example) and one failing test per rule:
  - body not an object; `schemaVersion` not `"1.0"`;
  - `vehicleMasterId` not a positive integer; empty `deviceId`;
  - `sessionId` or `batchId` not a UUID; `x-idempotency-key` present and different from `batchId`;
  - `sentAtMs`, `firstSequence`, `lastSequence` not non-negative integers;
  - `frames` empty, not an array, or longer than 200;
  - frame `sequence` not strictly increasing;
  - `firstSequence` or `lastSequence` not matching the frames;
  - `receivedAtMs` or `monotonicMs` invalid;
  - `canId` above `0x7FF` with `isExtended: false`; above `0x1FFFFFFF` with `isExtended: true`; `isExtended` not boolean;
  - `dlc` outside 0 to 8; `dataBase64` not valid Base64; decoded length different from `dlc`;
  - `direction` not `rx`/`tx`; `channel` negative.
  - Also: `dlc: 0` with `dataBase64: ""` is valid; an unknown CAN id is valid.
- [ ] Run the tests; expect failure.
- [ ] Implement. Reasons name the field and frame index, for example `frames[3].dlc must be an integer 0..8`.
- [ ] Run the tests; expect pass.

### Task 3: Store

**Files:** create `raw-can-trial/store.js`. No unit test (it is a thin SQL wrapper); it is exercised by the replay script against a local database in Task 8.

- [ ] Implement `insertBatch(batch, receivedAtMs)` using `config/postgres`:
  - One statement: insert the row with `server_received_at = to_timestamp($ms / 1000.0)`, set `overlap` from an `EXISTS` check for another batch of the same device and session whose sequence range intersects, `ON CONFLICT (batch_id) DO NOTHING`, `RETURNING overlap`.
  - If no row was returned, select the stored row's `last_sequence`, `frame_count`, `server_received_at` and return it with `duplicate: true`.
  - Return `{ duplicate, overlap, ackSequence, acceptedFrames, serverReceivedAtMs }`.

### Task 4: Route

**Files:** create `raw-can-trial/route.js`; test `raw-can-trial/tests/route.test.js` (mocks `../store`).

- [ ] Write tests on a bare Express app with `express.json()` and the router:
  - switch off: 503;
  - missing key, wrong key, key of different length: 401;
  - invalid body: 400 with `accepted: false` and a `reason`;
  - pair not allowed: 403;
  - new batch: 202 with `accepted`, `batchId`, `acceptedFrames`, `ackSequence`, `serverReceivedAtMs`, `status: "stored"`;
  - duplicate: 200 with `duplicate: true`;
  - overlap: 202 with `overlap: true`;
  - store throws: 500, and nothing about the error leaks in the body.
- [ ] Run; expect failure.
- [ ] Implement the order of checks from the spec. Use `crypto.timingSafeEqual` for the key. Capture `Date.now()` on arrival and pass it to the store.
- [ ] Run; expect pass.

### Task 5: Mount and error handler

**Files:** create `raw-can-trial/index.js`; test `raw-can-trial/tests/mount.test.js`.

- [ ] Write tests with an app that calls `mount(app)` and then `app.use(express.json({ limit: '10mb' }))` and a catch-all route, as `app.js` does:
  - a 129 KiB body gets 413 with `accepted: false`;
  - malformed JSON gets 400 with `accepted: false`;
  - a gzip-compressed valid body is accepted (202);
  - the 601st request in a minute gets 429;
  - a request to another path is not affected by the trial's limiter or parser.
- [ ] Run; expect failure.
- [ ] Implement `mount(app)` with `rateLimiter({ windowMs: 60_000, max: 600, keyPrefix: 'rawcan' })`, `express.json({ limit: '128kb' })`, the router, and a four-argument error handler that maps `err.status` / `err.type` to the trial's JSON shape.
- [ ] Run; expect pass.

### Task 6: SQL files

**Files:** create `raw-can-trial/sql/create.sql`, `raw-can-trial/sql/remove.sql`.

- [ ] `create.sql`: the two tables and two indexes from the spec, all with `IF NOT EXISTS`, in one transaction.
- [ ] `remove.sql`: `DROP TABLE IF EXISTS raw_can_decoded, raw_can_batches;` in one transaction.

### Task 7: Wire into app.js

**Files:** modify `app.js`, one line after the CORS block and before `BODY PARSERS`.

- [ ] Add `require('./raw-can-trial').mount(app); // raw CAN shadow trial; remove with raw-can-trial/`.
- [ ] Check that `app.js` still loads: `node -e "require('./app')"` exits without throwing (Redis may log a connection error locally; that is existing behaviour).

### Task 8: Replay script and local end-to-end check

**Files:** create `raw-can-trial/scripts/replay.js`.

- [ ] Options: `--url`, `--key`, `--vehicle`, `--device`, `--batches`, `--frames`, `--interval-ms`, `--skip` (drop a sequence range to create a gap), `--duplicate` (resend one batch with the same id), `--gzip`. It prints each response status and body summary.
- [ ] Generate frames using real CAN ids from the spec with random payloads, a fresh session id, and increasing sequences.
- [ ] Manual check, only against a local backend with a local database, never production: start the server with the switch on, run the replay with a duplicate and a gap, and confirm 202s, one 200 duplicate, and rows in `raw_can_batches`.

### Task 9: README and full test run

**Files:** create `raw-can-trial/README.md`.

- [ ] Document: what the folder is, the three `.env` entries, how to create tables, how to run the replay, and the five removal steps.
- [ ] Run `npx jest raw-can-trial`; all tests pass.
- [ ] Run `git status` to confirm the only changes outside `raw-can-trial/` and `docs/` are the one line in `app.js` (plus Rahul's own pending edits).
