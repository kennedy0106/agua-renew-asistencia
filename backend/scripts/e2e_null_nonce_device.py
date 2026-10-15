"""Anula device_id del nonce más reciente. Solo base desechable de pruebas."""

import os
import sys

from sqlalchemy import create_engine, text

from app.core.test_db import assert_disposable_postgres_url


def main() -> None:
    if os.environ.get("ALLOW_TEST_DB_RESET") != "1":
        raise SystemExit("ALLOW_TEST_DB_RESET=1 es obligatorio")
    url = (os.environ.get("TEST_DATABASE_URL") or "").strip()
    assert_disposable_postgres_url(url)
    engine = create_engine(url)
    with engine.begin() as conn:
        result = conn.execute(
            text(
                """
                UPDATE attendance_consumed_nonces
                SET device_id = NULL
                WHERE created_at = (SELECT MAX(created_at) FROM attendance_consumed_nonces)
                """
            )
        )
        print(result.rowcount)
    engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
