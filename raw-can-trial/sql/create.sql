-- raw-can-trial/sql/create.sql
-- Raw CAN shadow trial: creates the trial's two tables.
-- Alters nothing that already exists. Safe to run more than once.
-- Undo with raw-can-trial/sql/remove.sql.

BEGIN;

-- One row per accepted batch, frames kept exactly as the tablet sent them.
CREATE TABLE IF NOT EXISTS raw_can_batches (
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

CREATE INDEX IF NOT EXISTS raw_can_batches_vehicle_time_idx
  ON raw_can_batches (vehicle_master_id, server_received_at);

CREATE INDEX IF NOT EXISTS raw_can_batches_session_seq_idx
  ON raw_can_batches (device_id, session_id, first_sequence);

-- Snapshots decoded by the trial's worker, in the same field names the app
-- uploads. Never read by the dashboard.
CREATE TABLE IF NOT EXISTS raw_can_decoded (
  vehicle_master_id   integer     NOT NULL,
  recorded_at         timestamptz NOT NULL,
  session_id          uuid        NOT NULL,
  last_sequence       bigint      NOT NULL,
  live                jsonb       NOT NULL,
  PRIMARY KEY (vehicle_master_id, recorded_at)
);

COMMIT;
