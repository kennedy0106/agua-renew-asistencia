# Attendance summary timing (opt-in, local)

Local timing instrumentation for `GET /api/v1/attendance/summary` only. Disabled
by default; when enabled it adds one numeric `Server-Timing` response header
when the response flows through the instrumented middleware.

## Enable

Set `SUMMARY_TIMING_ENABLED=1` (or `true`) in the backend environment and
restart the process. Default is `false`; with the flag off the route is
completely unchanged (no header, no instrumentation, no eager DB checkout).

## Header contract

`Server-Timing: summary_req;dur=<ms>, summary_dbconn;dur=<ms>, summary_dbsql;dur=<ms>`

When the header is present, all three metrics are present and their durations
are nonnegative milliseconds. The header is **not** guaranteed on every
response of the route:

- It is emitted only for responses that pass through `SummaryTimingMiddleware`.
  Normal responses and handled HTTP errors (for example 401/403) include it.
- Starlette's outer error middleware renders an unhandled 500 outside this
  middleware, so those responses carry no `Server-Timing` header. The
  accumulator and its listeners are still cleaned up by `get_db`.
- The header schema is preserved: `summary_dbconn` is rendered as `0.000` both
  when acquisition was measured as zero and when acquisition never happened
  (for example a response produced before `get_db` runs). A rendered zero does
  not distinguish "measured zero" from "not measured".

No SQL text, parameters, identities, cookies, URLs or DSNs are recorded or
emitted.

| Metric | Boundary |
| --- | --- |
| `summary_req` | Request processing until the response headers are sent. Includes authentication and marshalling. |
| `summary_dbconn` | Wall time of the explicit `Session.connection()` acquisition for the request. Includes pool checkout setup and `pool_pre_ping` (`pool_pre_ping` is DBAPI activity that happens **before** any cursor event). It is **not** a pure queue wait. |
| `summary_dbsql` | Cumulative cursor execution time (`before_cursor_execute` → `after_cursor_execute`) on the request connection. Excludes acquisition and result fetching, and does **not** represent database CPU time. |

`summary_dbsql` includes the authentication lookup plus the four summary count
statements, because dependency teardown shares one session for the whole
request. A cursor execution that raises is not counted: SQLAlchemy emits
`before_cursor_execute` but not `after_cursor_execute`, so the failed statement's
duration is discarded (pending starts are cleared on detach) and only
successful statements contribute.

## Implementation boundaries

- The ASGI middleware is scoped to method `GET` and the exact path. It stores
  the accumulator in `scope["state"]`; `get_db` reads it from `Request.state`.
  The scope dict is the same object across the ASGI middleware and the sync
  dependency thread, so no `ContextVar` propagation is assumed.
- `get_db` forces `db.connection()` only when the accumulator is present. This
  captures checkout setup/pre-ping inside `summary_dbconn`; otherwise the
  session acquires its connection lazily as before.
- SQLAlchemy cursor listeners are attached to the request's `Connection` object,
  never to the engine or pool. If registration fails, already-registered
  listeners are removed best-effort before the original error propagates.
  If removal itself fails, a listener may remain on that Connection object;
  cleared collector bookkeeping does not prove physical removal.
- Listener removal is attempted in `get_db`'s `finally` before session closure.
  A failing removal does not skip the others or mask an in-flight business
  error, and `db.close()` is still attempted. A failure of `db.close()` itself
  can propagate. Tested SQL errors and unauthorized requests preserve their
  status/body.

## Browser visibility

The header is visible in browser DevTools for the response. For cross-origin
requests, same-origin JavaScript cannot read it through the Resource Timing API
unless the response also sends `Timing-Allow-Origin`; this change does not add
that header. Local DevTools inspection and same-origin reads are unaffected.

## Verification

Focused runners (offline, no dependency install):

```bash
cd backend && uv run --no-sync --offline pytest tests/test_attendance_summary_timing.py -q
cd backend && uv run --no-sync --offline pytest tests/test_attendance_admin.py -q
cd backend && uv run --no-sync --offline pytest
```

This change is preparation only. No deploy, production setting change, SQL
optimization, migration or production measurement is included.
