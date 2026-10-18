# Prepared public marking (B4)

B4 activates the mandatory backend/client preparation lifecycle together. It uses the additive preparation table introduced in B3; it does not apply migrations or deploy production. Optional address lookup remains B5, and confirmed private stamped retrieval/admin viewing remain B6. Do not deploy an intermediate unit.

## Public preparation

After valid DNI/internal-code/AR identification establishes a signed browser context, send the marking token with a fresh one-shot browser location:

```http
POST /api/v1/attendance/attempt/prepare
Content-Type: application/json
```

```json
{
  "marking_token": "token-from-identification",
  "location": {
    "latitude": -12.046374,
    "longitude": -77.042793,
    "accuracy_m": 12.5,
    "age_ms": 1500
  }
}
```

The request must carry the same browser's signed cookie. Coordinates must be finite and within geographic bounds; accuracy is greater than zero and at most 50 metres, and monotonic age is from 0 through 60,000 ms. Nonstandard JSON constants and numeric overflow return 422 with `El cuerpo debe ser JSON con números finitos`, without echoing non-finite values.

A successful response contains the same attempt's renewed `marking_token`, server `marked_at`, `expires_at`, and nested `location`. Expiry is fixed at preparation time plus five minutes. Repeating a nonce returns the same snapshot; it does not create attendance, events or counters or restart the deadline. Server-observed age is derived from the supplied monotonic age, not the device's wall clock. Browser-reported coordinates/accuracy are not proof of physical presence.

## Photo, marking and recovery

- Signed photo upload and marking require a matching employee/action/nonce/browser preparation. Missing or expired preparation rejects the write; required photo, active-worker, replay and rate controls remain enforced.
- Official entry/exit and related event/work-date calculations use the reserved server time, not upload completion or a client clock. Employee locking also protects stale-target and chronology checks. An old preparation is rejected rather than shifted past a completed shift; checkout cannot precede its entry or target a closed/different record.
- `/api/v1/attendance/attempt/status` may add nullable `marking_token` and nested `preparation` to the existing status fields. Bounded recovery never extends the stored expiry or invents a snapshot. The client accepts a replacement token only for the same attempt identity/nonce.
- Cancel/restart and confirmed replay preserve existing ownership and idempotence rules. Recovery does not authorize an expired write. A different/revoked browser cannot adopt an old attempt.
- The private original-photo read/list contract is unchanged in B4. No stamped-image endpoint or additive admin evidence metadata is activated yet. Address enrichment is an explicit no-op in this slice, even if a provider key exists.

No backfill, face recognition, geofence or continuous tracking is introduced. Production schema/recovery preflight and coordinated rollout remain separate release gates. Synthetic API tests, disposable PostgreSQL CI, browser mocks and the user's later physical-phone check are distinct kinds of evidence.
