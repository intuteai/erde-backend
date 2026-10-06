-- raw-can-trial/sql/remove.sql
-- Raw CAN shadow trial: drops the trial's two tables and all trial data.
-- Touches nothing else. Export anything you want to keep first.

BEGIN;

DROP TABLE IF EXISTS raw_can_decoded;
DROP TABLE IF EXISTS raw_can_batches;

COMMIT;
