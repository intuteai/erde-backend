-- 2026-10-07 — Oil motor (MCU2) telemetry
-- Contract: HMI sends live.oil_motor_speed_rpm / live.oil_motor_temp_c (both nullable, may be absent).
-- Must be applied BEFORE deploying the backend that writes these columns.
-- Nullable, no default → metadata-only on PG17 (no table rewrite). Idempotent.
-- Types match motor_speed_rpm (integer) / motor_temp_c (numeric(5,2)).

ALTER TABLE live_values
  ADD COLUMN IF NOT EXISTS oil_motor_speed_rpm integer      NULL,
  ADD COLUMN IF NOT EXISTS oil_motor_temp_c    numeric(5,2) NULL;
