# Recovery and payroll query batching: integration tracker

This feature branch integrates the verified backend performance changes before
production. Keep its tracker pull request draft and unmerged until all child
units have passed the required checks and have been integrated in order.

## Chain

| Order | Branch | Scope | Authored code/test lines |
| --- | --- | --- | ---: |
| 1 | `perf/recovery-payroll-foundation` | Opt-in salary/schedule scalar-tie compatibility, shared fixtures and legacy-tie regressions | 517 |
| 2 | `perf/recovery-payroll-recovery` | Batched recovery listing/origin components and recovery query/result regressions | 539 |
| 3 | `perf/recovery-payroll-payroll` | Batched payroll reads and payroll snapshot/query regressions | 489 |

Each child targets its immediate parent; the first targets
`perf/recovery-payroll-integration`. The final tracker targets the verified
repository default branch, `main`. The 400-line review heuristic is advisory:
these are coherent units with their tests, not artificially compressed slices.

## Verified candidate

- The original local candidate passed 49 directed compatibility tests after
  the legacy-tie correction, plus independent bounded verification.
- Independent checks preserved scalar salary/base/expected-minute selection,
  origin recovery credit, employee isolation, snapshot fingerprints, unchanged
  default bulk consumers, and bounded queries across tied history boundaries.
- Native review approved and acknowledged the original eight source/test
  paths. Individual child states still require their own CI evidence.
- Shared test fixtures are introduced as module prefixes in the foundation;
  later units add their remaining tests. The final source/test bytes must
  match the verified original candidate; no product code is rewritten to slice.

## Production safeguards

- Merge no child directly to `main`; production waits for final integration.
- Require backend, frontend, frontend-react, e2e and e2e-integration checks.
- Do not bypass protection, force push, change service variables, or migrate.
- Preserve the pinned, frozen-dependency, server-only Docker entrypoint and
  existing database/object store; no frontend, schema or dependency change.
- Before the final merge, confirm applicable release-preflight evidence.
- After auto-deploy, bind the exact Railway deployment to the merged commit
  and verify `/health` and `/health/db`; a healthy endpoint alone is not
  evidence of a schema migration or a production performance improvement.
