# Attendance preparation foundations (B3)

This slice adds unused preparation storage/contracts and a standalone browser GPS helper. It does **not** enable preparation endpoints, change attempt-status responses or activate GPS in the attendance page. Those server/client changes ship together in B4; this intermediate slice must not be deployed independently.

## Storage and input contract

- Migration `u7c8d9e0f1a2` follows `t6b7c8d9e0f1`. It creates only `attendance_preparations` and its four indexes; it does not backfill or alter existing attendance data.
- `nonce` is the new table's primary key. Foreign keys reference the employee, browser device and optional attendance record. The model carries the reserved timestamps, GPS snapshot, optional address and employee display snapshot.
- `LocationInput` requires finite coordinates within latitude `[-90, 90]` and longitude `[-180, 180]`, accuracy greater than zero and at most **50 metres**, and integer monotonic age from **0 through 60,000 ms**.
- `AttemptPrepareRequest` combines a marking token and location. `PreparationSnapshot`/`AttemptPrepareResponse` describe the reserved time, expiry, nested location and refreshed token. These types alone neither authenticate nor persist an attempt.
- The existing `AttemptStatusResponse` remains unchanged in B3. Browser ownership, nonce binding, fixed five-minute expiry, chronology and write/recovery orchestration become active atomically in B4; merely constructing a DTO/model does not enforce that lifecycle.

Downgrade deliberately raises `RuntimeError` instead of deleting auditable preparation data. Do not apply or downgrade this migration in production as part of B3. The full release requires its separate production preflight and coordinated rollout.

## Browser helper

`frontend-react/app/src/lib/attendance-location.ts` performs a single high-accuracy `getCurrentPosition` call with no cached position and a separate **20-second** deadline. It never uses `watchPosition`; age is computed from the monotonic clock rather than the device's wall clock. Reported GPS accuracy is an estimate, not proof of physical presence. No provider, address lookup or continuous tracking is activated here.

## Verification boundaries

Backend contract tests cover the input boundaries/non-finite rejection, DTO shape, model metadata, public Alembic **offline** additive SQL/downgrade refusal and unchanged status shape. Offline SQL is not proof of an applied PostgreSQL migration, preserved live rows or backup recovery. The four original pure browser-helper cases are retained; preparation API cases belong to B4 and private evidence cases to B6. Local frontend runtime/build and real PostgreSQL integration remain separate CI checks, not inferred from source or syntax inspection.
