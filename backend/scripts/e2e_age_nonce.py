"""Envejece un nonce consumido. Solo base desechable de pruebas."""

import os
import sys

from sqlalchemy import create_engine, text

from app.core.test_db import assert_disposable_postgres_url


def main() -> None:
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        raise SystemExit("ALLOW_TEST_DB_RESET=1 es obligatorio")
    nonce = (os.environ.get("E2E_AGE_NONCE") or "").strip()
    if not nonce:
        raise SystemExit("E2E_AGE_NONCE es obligatorio")
    url = (os.environ.get("TEST_DATABASE_URL") or "").strip()
    assert_disposable_postgres_url(url)
    engine = create_engine(url)
    with engine.begin() as conn:
        result = conn.execute(
            text(
                """
                UPDATE attendance_consumed_nonces
                SET created_at = now() - interval '2 hours'
                WHERE nonce = :nonce
                """
            ),
            {"nonce": nonce},
        )
        print(result.rowcount)
    engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
