# Optional address enrichment (B5)

B5 connects the existing reverse-address helper to the existing check-in and check-out confirmation hooks. It does not add an endpoint, schema change, migration, login requirement or private stamped-image feature. [Prepared marking](attendance-prepared-marking.md) remains the mandatory core; private stamped retrieval/admin viewing remains B6. Do not deploy an intermediate unit.

## When enrichment happens

Preparation and photo upload do not query the address provider. After the existing token, browser, photo, expiry, target and chronology guards accept confirmation, the service may enrich that attempt's preparation before the normal marking transaction commits.

- The address is optional descriptive text. It never replaces GPS coordinates, accuracy, observed time, reserved official marking time or the fixed expiry.
- An already populated address is not replaced. Historical records are not backfilled.
- A missing address or an unavailable lookup does not reject an otherwise valid mark. Timeout, provider quota and transport failures leave the address absent while normal entry/exit effects continue.
- The existing same-browser, same-nonce preparation response can expose the stored nullable `location.address` after confirmation. Reading it does not create attendance/counters or renew the original deadline.

## Configuration and unchanged safeguards

The existing backend setting is `Settings.geoapify_api_key`, default `""` (`GEOAPIFY_API_KEY`). This unit does not configure a key or activate a provider. Never put credentials in source or chat.

Without a key, the helper returns no address before network or cache access. With a separately authorized configuration, the unchanged helper uses a fixed Geoapify HTTPS host, rejects redirects, sets a four-second HTTP transport timeout and limits response reads to 16 KiB. Formatted provider text is bounded; the service adapter additionally caps stored text at 500 characters.

Cache and admission safeguards are local to a process: 256 cache entries with a ten-minute TTL, coordinates rounded to four decimal places for cache keys, at most 0.25 seconds of admission wait, and 2,500 admissions per process window of 24 hours. These are not account-wide quota coordination or an end-to-end latency guarantee. The synchronous optional call can add waiting time; failure isolation does not mean zero latency.

An approximate address is not a physical-presence guarantee. No geofence, continuous tracking or face recognition is introduced.

## Verification boundary

`backend/tests/test_attendance_address.py` exercises public preparation, required photo upload, check-in/out and the owned-nonce snapshot with fake provider transport and a fake helper clock. It covers keyless marking, configured enrichment/cache reuse, timeout and HTTP 429 failure isolation, unchanged GPS/time/expiry, one completed attendance record, stable counters on snapshot retries, and the retained default-setting case.

Synthetic HTTP/SQLite/Moto evidence does not establish live-provider availability, shared account quota, real-phone GPS/camera behavior, production performance or recovery. Production configuration/schema/recovery preflight and the coordinated rollout remain separate gates; the user validates a physical phone afterward.
