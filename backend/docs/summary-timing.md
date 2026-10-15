# Read endpoint timing (opt-in)

Numeric timing instrumentation for four existing GET routes. Disabled by
default; when enabled it adds one `Server-Timing` response header when the
response flows through the instrumented middleware. Bodies, authentication,
queries and business-data behavior are unchanged.

| GET route | Metric prefix |
| --- | --- |
| `/api/v1/attendance/summary` | `summary_` (unchanged) |
| `/api/v1/employees/{employee_id}/adjustments` | `api_` |
| `/api/v1/employees/{employee_id}/balance` | `api_` |
| `/api/v1/work-calendar/employees/{employee_id}/days` | `api_` |

Employee IDs must have the canonical hyphenated UUID shape. Other paths,
methods, invalid UUID shapes and trailing/suffixed paths are not instrumented;
normal router handling remains unchanged. Query parameters do not affect
route matching. Use explicit date bounds when measuring balance/calendar.

## Enable

Set `SUMMARY_TIMING_ENABLED=1` (or `true`) in the backend environment and
restart the process. The existing flag controls all four routes; no additional
flag or environment change is needed when it is already enabled. Default is
`false`; with the flag off each route is completely unchanged (no header, no instrumentation, no eager DB checkout).

## Header contract

Summary (existing contract):

`Server-Timing: summary_req;dur=<ms>, summary_dbconn;dur=<ms>, summary_dbsql;dur=<ms>`

The three employee reads use the same measurement boundaries:

`Server-Timing: api_req;dur=<ms>, api_dbconn;dur=<ms>, api_dbsql;dur=<ms>`

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

`summary_dbsql` includes the authentication lookup plus one combined summary
counter statement: two cursor executions per normal request, instead of five.
The combined statement preserves distinct employees present today, active
employee counts, all-time open entries, and today's completed records. No
cache, schema change, or authentication change is involved. Dependency teardown
shares one session for the whole request. A cursor execution that raises is not counted: SQLAlchemy emits
`before_cursor_execute` but not `after_cursor_execute`, so the failed statement's
duration is discarded (pending starts are cleared on detach) and only
successful statements contribute.

## Implementation boundaries

- The ASGI middleware is scoped to method `GET` and the exact allowlist. It stores
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

### Isolated Windows launcher

From `backend`, use the existing virtual environment (no dependency installation):

```powershell
.venv/Scripts/python.exe -I -B scripts/verify_summary_local.py
```

The launcher uses Python's native temporary-directory API rather than passing
Windows paths through nested Bash/`mktemp`. It copies only Python sources and
`pyproject.toml` into the explicitly authorized
`C:/Users/USER/AppData/Local/Temp/agua-summary-verify` subtree. It discards inherited
application credentials, disables dotenv before loading settings, and refuses to
run if the application has a configured database engine. Tests use SQLite/moto;
no production database is used. Source hashes must match before and after.

It runs summary performance, timing, administrative, and launcher regressions,
preserves pytest stdout/stderr and its exit status, and retains the isolated
copy for inspection. `ISOLATED_COPY` identifies that copy; `SOURCE_UNCHANGED=1`
and `FOCUSED_EXIT=0` indicate success. The script does not commit, deploy, alter
branch protection, or replace required GitHub checks. Its fixed external path
is specific to the currently authorized local environment.

### Other focused commands

These commands do not sanitize inherited environment or dotenv configuration;
use them only in an already isolated development environment:

Focused runners (offline, no dependency install):

```bash
cd backend && uv run --no-sync --offline pytest tests/test_employee_read_timing.py tests/test_attendance_summary_performance.py tests/test_attendance_summary_timing.py -q
cd backend && uv run --no-sync --offline pytest tests/test_attendance_admin.py -q
cd backend && uv run --no-sync --offline pytest
```

## Interpreting measurements

`api_req` has the same boundary as `summary_req`: request processing through
response headers, including authentication and serialization, not full-body
browser time. `api_dbconn` includes checkout/pre-ping; `api_dbsql` sums successful
cursor executions, including authentication, but excludes result fetching and
is not database CPU time. These are durations, not statement counts.

A zero connection duration also means acquisition might not have occurred,
just as for the summary contract. Unhandled 500 responses may lack the header.
No metrics include employee identifiers or query strings. No logging, SQL text,
parameters, business data, cookies or credentials are added.

Measure sequential authenticated same-origin GETs with explicit date bounds,
drain bodies without exporting their content, and retain only status and numeric
timings. The browser total minus `api_req` is not pure network latency; independent
medians do not add. Three/five samples do not establish a reliable percentile
or a controlled A/B comparison. CORS/Timing-Allow-Origin are not changed.

The code does not perform deployment, migrations or database maintenance.

## Balance query budget

The balance read reuses one attendance aggregate and one active manual-day
fetch for both ordinary and actual worked minutes. Manual normal minutes and
snapshot-adjusted payable minutes remain distinct. One conditional aggregate
returns both approved adjustment minutes and their overtime subset; pending,
rejected, voided and out-of-range adjustments remain excluded. Existing shared
payroll/calendar helpers and recovery-credit calculations are unchanged.

Public HTTP regressions with an isolated administrative session observe seven
SELECTs per empty/mixed balance request, down from ten (including authentication).
An in-range recovery commitment still adds five reads, giving twelve rather
than fifteen in the recovery fixture. This removes three redundant reads;
it does not batch the recovery loop or change calculations, permissions or
stored data. Counts are verified in tests, not exported in production headers.

Run the balance budget regression in an already isolated development environment:

```bash
cd backend && uv run --no-sync --offline pytest tests/test_balance_query_budget.py -q
```
