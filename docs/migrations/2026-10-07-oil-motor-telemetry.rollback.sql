-- Rollback for 2026-10-07-oil-motor-telemetry.sql
-- Roll back the backend code FIRST (it inserts into these columns), then run this.

ALTER TABLE live_values
  DROP COLUMN IF EXISTS oil_motor_speed_rpm,
  DROP COLUMN IF EXISTS oil_motor_temp_c;
