"""Timing de ``GET /api/v1/attendance/summary`` (T1).

Los tests ejercitan la dependencia real ``get_db`` con un ``SessionLocal``
SQLite monkeypatcheado (no la sobrescriben con ``db_session``), de modo que la
instrumentación real se valida en lugar de reemplazarse por métricas falsas.
El reloj se inyecta para que los límites sean deterministas, sin ``sleep``.
"""

import itertools
import math
import queue
import re
import threading
from collections import defaultdict
from types import SimpleNamespace

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool, StaticPool

from app.core import request_timing
from app.core.config import get_settings
from app.core.request_timing import SummaryTiming
from app.core.security import hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository

_LOGIN = {"username": "admin", "password": "Admin123!"}
_SUMMARY_PATH = "/api/v1/attendance/summary"
_METRIC_NAMES = {"summary_req", "summary_dbconn", "summary_dbsql"}
_MS = 1000.0


class StepClock:
    """Reloj determinista: cada lectura avanza un paso fijo."""

    def __init__(self, step: float = 1.0) -> None:
        self.step = step
        self.value = 0.0
        self.calls = 0

    def __call__(self) -> float:
        self.calls += 1
        current = self.value
        self.value += self.step
        return current


class ThreadStepClock:
    """Reloj determinista por hilo: cada lectura avanza un paso fijo.

    Bajo concurrencia cada hilo mantiene su propia secuencia, de modo que el
    par ``before``/``after`` de un mismo cursor difiere exactamente en un paso
    aunque otro hilo llame al reloj en paralelo.
    """

    def __init__(self, step: float = 1.0) -> None:
        self.step = step
        self._local = threading.local()

    def __call__(self) -> float:
        current = getattr(self._local, "value", 0.0)
        self._local.value = current + self.step
        return current


def parse_server_timing(header: str) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for part in header.split(","):
        name, _, dur = part.strip().partition(";dur=")
        metrics[name.strip()] = float(dur)
    return metrics


def _empty_request(collector: SummaryTiming | None = None) -> Request:
    scope: dict = {"type": "http"}
    if collector is not None:
        scope["state"] = {"summary_timing": collector}
    return Request(scope)


@pytest.fixture()
def step_clock(monkeypatch):
    clock = StepClock(step=1.0)
    monkeypatch.setattr(request_timing, "_now", clock)
    return clock


@pytest.fixture()
def timing_flag(monkeypatch):
    """Habilita/deshabilita el flag por variable de entorno (default: off)."""

    def _set(enabled: bool) -> None:
        if enabled:
            monkeypatch.setenv("SUMMARY_TIMING_ENABLED", "1")
        else:
            monkeypatch.delenv("SUMMARY_TIMING_ENABLED", raising=False)
        get_settings.cache_clear()

    _set(False)
    yield _set
    get_settings.cache_clear()


@pytest.fixture()
def created_collectors(monkeypatch):
    """Captura las instancias reales que crea el middleware."""
    created: list = []

    class Recording(SummaryTiming):
        def __init__(self) -> None:
            super().__init__()
            created.append(self)

    monkeypatch.setattr(request_timing, "SummaryTiming", Recording)
    return created


@pytest.fixture()
def real_db(monkeypatch):
    """Engine SQLite + ``SessionLocal`` real monkeypatcheado (sin override de get_db)."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

    session = factory()
    role = SystemRoleRepository(session).create(name="ADMIN", description="Administrador")
    UserRepository(session).create(
        username="admin",
        password_hash=hash_password("Admin123!"),
        system_role_id=role.id,
    )
    session.commit()
    session.close()

    monkeypatch.setattr("app.db.session.SessionLocal", factory)
    yield factory, engine
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def cursor_counter(real_db):
    """Cuenta ejecuciones de cursor en el engine de prueba (solo test)."""
    engine = real_db[1]
    counter = SimpleNamespace(count=0)

    def _inc(*_args, **_kwargs) -> None:
        counter.count += 1

    event.listen(engine, "before_cursor_execute", _inc)
    yield counter
    event.remove(engine, "before_cursor_execute", _inc)


def _timing_client() -> TestClient:
    # Sin override de get_db: la dependencia real se ejecuta.
    return TestClient(app)


def _login(client: TestClient) -> None:
    response = client.post("/api/v1/auth/login", json=_LOGIN)
    assert response.status_code == 200, response.text


# --- Dependencia get_db: adquisición explícita solo con collector ---


def test_get_db_does_not_acquire_connection_without_collector(monkeypatch):
    calls: list[str] = []

    class FakeSession:
        def connection(self):
            calls.append("connection")
            return None

        def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    generator = get_db(_empty_request())
    next(generator)  # yield: aún no se usa la conexión
    assert calls == []
    generator.close()
    assert "close" in calls


def test_get_db_performs_explicit_acquisition_with_collector(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool)
    real_connection = engine.connect()
    calls: list[str] = []

    class FakeSession:
        def connection(self):
            calls.append("connection")
            return real_connection

        def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    collector = SummaryTiming()
    generator = get_db(_empty_request(collector))
    next(generator)
    assert calls == ["connection"]
    assert collector.has_active_listeners() is True
    generator.close()
    assert collector.has_active_listeners() is False
    assert calls == ["connection", "close"]
    real_connection.close()
    engine.dispose()


def test_acquire_metric_includes_connection_setup(monkeypatch, step_clock):
    engine = create_engine("sqlite://", poolclass=StaticPool)
    # El trabajo de setup del checkout consume tiempo del reloj dentro de la ventana.
    event.listen(engine, "connect", lambda *_args: request_timing._now())
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr("app.db.session.SessionLocal", factory)

    collector = SummaryTiming()
    generator = get_db(_empty_request(collector))
    next(generator)
    # begin + tick de setup + finish ⇒ dos pasos, no una espera pura de un paso.
    assert collector.acquire_seconds == 2 * step_clock.step
    assert collector.acquire_seconds > step_clock.step
    generator.close()
    engine.dispose()


# --- Listeners de cursor: límite exacto y aislamiento ---


def test_sql_metric_excludes_result_fetching(monkeypatch, step_clock):
    engine = create_engine("sqlite://", poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE t (x INTEGER)"))
        conn.execute(text("INSERT INTO t (x) VALUES (1), (2), (3)"))
    connection = engine.connect()
    collector = SummaryTiming()
    collector.attach(connection)

    result = connection.execute(text("SELECT x FROM t"))
    executed = collector.sql_seconds
    assert executed == step_clock.step

    rows = result.fetchall()
    assert len(rows) == 3
    # El fetch no agrega tiempo: solo la ejecución del cursor se mide.
    assert collector.sql_seconds == executed

    collector.detach()
    connection.close()
    engine.dispose()


def test_listener_isolation_across_overlapping_connections(monkeypatch, step_clock):
    engine = create_engine("sqlite://", poolclass=StaticPool)
    first = engine.connect()
    second = engine.connect()
    collector_a = SummaryTiming()
    collector_b = SummaryTiming()
    collector_a.attach(first)
    collector_b.attach(second)

    first.execute(text("SELECT 1"))
    assert collector_a.sql_seconds == step_clock.step
    assert collector_b.sql_seconds == 0.0

    second.execute(text("SELECT 1"))
    assert collector_a.sql_seconds == step_clock.step
    assert collector_b.sql_seconds == step_clock.step

    collector_a.detach()
    snapshot = collector_a.sql_seconds
    first.execute(text("SELECT 1"))
    assert collector_a.sql_seconds == snapshot  # sin listeners residuales

    collector_b.detach()
    first.close()
    second.close()
    engine.dispose()


# --- Limpieza parcial de listeners (adjuntar/retirar) ---


def test_attach_cleans_up_partial_registration(monkeypatch):
    """Si el segundo registro falla, el primero no debe quedar pegado."""
    engine = create_engine("sqlite://", poolclass=StaticPool)
    connection = engine.connect()
    collector = SummaryTiming()
    real_event = request_timing.sa_event
    registered: list[tuple[str, object]] = []

    def _failing_listen(target, name, handler, **kwargs):
        registered.append((name, handler))
        if len(registered) == 2:
            raise RuntimeError("registro parcial")
        return real_event.listen(target, name, handler, **kwargs)

    monkeypatch.setattr(
        request_timing,
        "sa_event",
        SimpleNamespace(listen=_failing_listen, remove=real_event.remove),
    )
    with pytest.raises(RuntimeError, match="registro parcial"):
        collector.attach(connection)

    assert collector.has_active_listeners() is False
    first_name, first_handler = registered[0]
    assert real_event.contains(connection, first_name, first_handler) is False
    connection.close()
    engine.dispose()


def test_detach_attempts_all_removals_when_first_fails(monkeypatch):
    """El fallo al retirar un listener no debe impedir retirar el resto."""
    engine = create_engine("sqlite://", poolclass=StaticPool)
    connection = engine.connect()
    collector = SummaryTiming()
    collector.attach(connection)

    real_event = request_timing.sa_event
    attempts: list[str] = []

    def _failing_remove(target, name, handler, **kwargs):
        attempts.append(name)
        if len(attempts) == 1:
            raise RuntimeError("retiro fallido")
        return real_event.remove(target, name, handler, **kwargs)

    monkeypatch.setattr(
        request_timing,
        "sa_event",
        SimpleNamespace(listen=real_event.listen, remove=_failing_remove),
    )
    collector.detach()  # no debe propagar

    assert attempts == ["before_cursor_execute", "after_cursor_execute"]
    assert collector.has_active_listeners() is False
    connection.close()
    engine.dispose()


def test_get_db_closes_session_even_if_detach_raises(monkeypatch):
    """Un fallo inesperado en ``detach`` no debe impedir cerrar la sesión."""
    engine = create_engine("sqlite://", poolclass=StaticPool)
    connection = engine.connect()
    calls: list[str] = []

    class FakeSession:
        def connection(self):
            calls.append("connection")
            return connection

        def close(self):
            calls.append("close")

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: FakeSession())
    collector = SummaryTiming()

    def _raise_detach(self):
        raise RuntimeError("detach roto")

    monkeypatch.setattr(request_timing.SummaryTiming, "detach", _raise_detach)
    generator = get_db(_empty_request(collector))
    next(generator)
    with pytest.raises(RuntimeError, match="detach roto"):
        generator.close()

    assert calls == ["connection", "close"]
    connection.close()
    engine.dispose()


# --- Integración HTTP ---


def test_disabled_by_default_adds_no_header(real_db, timing_flag, step_clock, created_collectors):
    timing_flag(False)
    with _timing_client() as client:
        _login(client)
        response = client.get(_SUMMARY_PATH)
    assert response.status_code == 200
    assert response.json()["employees_active"] == 0
    assert "server-timing" not in response.headers
    assert created_collectors == []


def test_non_target_route_untouched_even_when_enabled(real_db, timing_flag, step_clock, created_collectors):
    timing_flag(True)
    with _timing_client() as client:
        health = client.get("/health")
        wrong_method = client.post(_SUMMARY_PATH)
    assert health.status_code == 200
    assert "server-timing" not in health.headers
    assert wrong_method.status_code == 405
    assert "server-timing" not in wrong_method.headers
    assert created_collectors == []


def test_enabled_target_reports_three_numeric_metrics(
    real_db, timing_flag, step_clock, created_collectors, cursor_counter
):
    timing_flag(True)
    with _timing_client() as client:
        _login(client)
        cursor_counter.count = 0
        response = client.get(_SUMMARY_PATH)

    assert response.status_code == 200
    assert set(response.json()) == {
        "employees_active",
        "present_today",
        "no_entry_today",
        "open_entries",
        "checked_out_today",
    }
    header = response.headers["server-timing"]
    metrics = parse_server_timing(header)
    assert set(metrics) == _METRIC_NAMES
    assert all(math.isfinite(value) and value >= 0 for value in metrics.values())
    # Adquisición explícita única y ejecución de cursor acumulada exacta (ms).
    assert metrics["summary_dbconn"] == step_clock.step * _MS
    assert metrics["summary_dbsql"] == cursor_counter.count * step_clock.step * _MS
    # Includes authentication plus one combined counter query.
    assert cursor_counter.count == 2
    assert metrics["summary_req"] >= metrics["summary_dbsql"] + metrics["summary_dbconn"]
    assert "SELECT" not in header and "/" not in header
    assert re.fullmatch(r"[\w;,=. ]+", header)
    assert created_collectors[-1].has_active_listeners() is False


def test_unauthorized_preserves_401_and_still_measures(
    real_db, timing_flag, step_clock, created_collectors
):
    timing_flag(True)
    with _timing_client() as client:
        response = client.get(_SUMMARY_PATH)

    assert response.status_code == 401
    assert response.json() == {"detail": "No autenticado"}
    metrics = parse_server_timing(response.headers["server-timing"])
    assert set(metrics) == _METRIC_NAMES
    # La autenticación está dentro de la ventana: adquisición medida, sin cursor aún.
    assert metrics["summary_dbconn"] == step_clock.step * _MS
    assert metrics["summary_dbsql"] == 0.0
    assert created_collectors[-1].has_active_listeners() is False


def test_repeated_requests_do_not_accumulate(
    real_db, timing_flag, step_clock, created_collectors, cursor_counter
):
    timing_flag(True)
    with _timing_client() as client:
        _login(client)
        cursor_counter.count = 0
        first = client.get(_SUMMARY_PATH)
        first_count = cursor_counter.count
        cursor_counter.count = 0
        second = client.get(_SUMMARY_PATH)
        second_count = cursor_counter.count

    first_metrics = parse_server_timing(first.headers["server-timing"])
    second_metrics = parse_server_timing(second.headers["server-timing"])
    assert first_count == second_count
    assert first_metrics["summary_dbsql"] == second_metrics["summary_dbsql"]
    assert first_metrics["summary_dbconn"] == second_metrics["summary_dbconn"] == step_clock.step * _MS
    assert created_collectors[-1].has_active_listeners() is False


def test_sql_error_preserves_status_and_cleans_up(real_db, timing_flag, step_clock, created_collectors, monkeypatch):
    timing_flag(True)
    from app.modules.attendance.repository import AttendanceRepository

    def _failing_sql(self, day):
        # SQL real que falla en SQLite: emite before_cursor_execute y nunca after.
        self.db.execute(text("SELECT * FROM tabla_inexistente_timing"))

    with TestClient(app, raise_server_exceptions=False) as client:
        _login(client)
        with monkeypatch.context() as context:
            context.setattr(AttendanceRepository, "summary_counts", _failing_sql)
            failed = client.get(_SUMMARY_PATH)
            assert failed.status_code == 500
            collector = created_collectors[-1]
            assert collector.has_active_listeners() is False
            # Solo se contó la autenticación previa; la ejecución fallida no aporta.
            assert collector.sql_seconds == step_clock.step

        # Tras el error los listeners no persisten: la siguiente petición es normal.
        recovered = client.get(_SUMMARY_PATH)
        assert recovered.status_code == 200
        metrics = parse_server_timing(recovered.headers["server-timing"])
        assert metrics["summary_dbconn"] == step_clock.step * _MS
        assert metrics["summary_dbsql"] > 0
        assert created_collectors[-1].has_active_listeners() is False


def test_unhandled_500_has_no_timing_header_but_cleans_up(
    real_db, timing_flag, step_clock, created_collectors, monkeypatch
):
    """El 500 no controlado lo emite el middleware externo: sin cabecera.

    El listener igual se retira porque el ``finally`` de ``get_db`` corre.
    """
    timing_flag(True)
    from app.modules.attendance.service import AttendanceService

    def _boom(self, today):
        raise RuntimeError("fallo no controlado")

    with TestClient(app, raise_server_exceptions=False) as client:
        _login(client)
        with monkeypatch.context() as context:
            context.setattr(AttendanceService, "summary", _boom)
            response = client.get(_SUMMARY_PATH)

    assert response.status_code == 500
    assert "server-timing" not in response.headers
    assert created_collectors[-1].has_active_listeners() is False


def test_concurrent_http_requests_isolate_sql_timing(tmp_path, monkeypatch, timing_flag):
    """Dos peticiones simultáneas: cada collector mide solo su conexión.

    Barrera determinista (sin ``sleep``): ambas peticiones quedan en vuelo con
    conexiones SQLite distintas antes de ejecutar SQL. Cada collector debe
    cuadrar exactamente con los cursores de su propia conexión, sin listeners
    de engine y sin acumulación entre peticiones.
    """
    timing_flag(True)
    from app.modules.attendance.service import AttendanceService

    engine = create_engine(
        f"sqlite:///{tmp_path / 'timing-concurrent.sqlite3'}",
        connect_args={"check_same_thread": False},
        poolclass=QueuePool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    seed = factory()
    role = SystemRoleRepository(seed).create(name="ADMIN", description="Administrador")
    UserRepository(seed).create(
        username="admin",
        password_hash=hash_password("Admin123!"),
        system_role_id=role.id,
    )
    seed.commit()
    seed.close()
    monkeypatch.setattr("app.db.session.SessionLocal", factory)

    per_connection: dict = defaultdict(int)

    def _count(conn, *_args, **_kwargs) -> None:
        per_connection[conn] += 1

    event.listen(engine, "before_cursor_execute", _count)

    pairs: list = []

    class Recording(SummaryTiming):
        def attach(self, connection):
            pairs.append((self, connection))
            super().attach(connection)

    monkeypatch.setattr(request_timing, "SummaryTiming", Recording)
    monkeypatch.setattr(request_timing, "_now", ThreadStepClock(step=1.0))

    original_summary = AttendanceService.summary
    extras: queue.Queue = queue.Queue()
    extras.put(1)
    extras.put(3)
    counter = itertools.count(1)
    barrier = threading.Barrier(2, timeout=10)

    def _gated_summary(self, today):
        index = next(counter)
        if index <= 2:
            extra = extras.get()
            barrier.wait(timeout=10)
            for _ in range(extra):
                self.db.execute(text("SELECT 1"))
        return original_summary(self, today)

    monkeypatch.setattr(AttendanceService, "summary", _gated_summary)

    with _timing_client() as client:
        _login(client)
        responses: list = []
        errors: list = []

        def _request() -> None:
            try:
                responses.append(client.get(_SUMMARY_PATH))
            except Exception as exc:  # pragma: no cover - se reporta como fallo
                errors.append(exc)

        threads = [threading.Thread(target=_request) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)

        assert errors == []
        assert {response.status_code for response in responses} == {200}
        # Tercera petición secuencial: sin listeners acumulados de anteriores.
        third = client.get(_SUMMARY_PATH)

    assert third.status_code == 200
    expected_keys = {
        "employees_active",
        "present_today",
        "no_entry_today",
        "open_entries",
        "checked_out_today",
    }
    for response in responses:
        assert set(response.json()) == expected_keys

    assert len(pairs) == 3
    for collector, connection in pairs:
        assert collector.has_active_listeners() is False
        assert collector.sql_seconds == per_connection[connection] * 1.0

    own_counts = sorted(per_connection[connection] for _, connection in pairs)
    assert own_counts == [2, 3, 5]
    header_values = sorted(
        parse_server_timing(response.headers["server-timing"])["summary_dbsql"]
        for response in responses
    )
    assert header_values == [3.0 * _MS, 5.0 * _MS]
    third_metrics = parse_server_timing(third.headers["server-timing"])
    assert third_metrics["summary_dbsql"] == 2.0 * _MS
    assert third_metrics["summary_dbconn"] == 1.0 * _MS

    event.remove(engine, "before_cursor_execute", _count)
    engine.dispose()
