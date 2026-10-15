# Backend redeployment with a preserved database

The Docker image starts only the API. It does not migrate, initialize, reset,
stamp, downgrade, or connect to a production database while building. Its base
is pinned to `ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58`.

This is deployment preparation, not authorization to build, deploy, restart,
or migrate a production service.

Before a redeployment, explicitly verify the target service configuration,
released commit, database revision, backup and restore evidence, object-store
reachability, and health endpoints. A successful image build or `/health/db`
does not prove schema compatibility. If a schema change is needed, schedule a
separate approved maintenance operation against a disposable rehearsal first.

The candidate runtime command is `exec /app/.venv/bin/uvicorn app.main:app
--host 0.0.0.0 --port ${PORT:-8000}`. It preserves the existing database and
evidence bucket; rollback of an image does not roll back a database.
