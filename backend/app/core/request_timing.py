"""Instrumentación de tiempos local y opcional para el resumen de asistencia.

Solo se emiten números: la cabecera ``Server-Timing`` lleva duraciones en
milisegundos. Nunca se registran SQL, parámetros, identidades, cookies, URLs ni
cadenas de conexión.

Tres métricas con límites explícitos:

- ``summary_req``: tiempo de procesamiento de la petición hasta enviar las
  cabeceras de respuesta. Incluye autenticación y serialización.
- ``summary_dbconn``: tiempo de pared de la adquisición explícita de
  ``Session.connection()``. Incluye cualquier setup del checkout y pre-ping del
  pool; no es espera pura de cola.
- ``summary_dbsql``: suma del tiempo de ejecución de cursores
  (``before/after_cursor_execute``) sobre la conexión de la petición. Excluye
  adquisición y obtención de resultados; no representa CPU de base de datos.

Los listeners se adjuntan a la conexión concreta de la petición (nunca al
engine) y se retiran en el ``finally`` de ``get_db``, antes de devolver la
conexión al pool.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import event as sa_event
from starlette.datastructures import MutableHeaders

from app.core.config import get_settings

TARGET_PATH = "/api/v1/attendance/summary"
STATE_KEY = "summary_timing"

REQUEST_METRIC = "summary_req"
CONNECTION_METRIC = "summary_dbconn"
SQL_METRIC = "summary_dbsql"

_HEADER_NAME = "Server-Timing"


def _now() -> float:
    """Reloj monotónico (inyectable en tests para determinismo)."""
    return time.perf_counter()


class SummaryTiming:
    """Acumulador por petición, compartido vía ``scope["state"]``.

    Es un objeto mutable compartido entre el middleware ASGI y la dependencia
    síncrona ``get_db`` (que corre en un hilo del threadpool). No usa
    ``ContextVar``: el diccionario de estado del scope es el mismo objeto en
    ambos.
    """

    __slots__ = (
        "request_started",
        "acquire_seconds",
        "sql_seconds",
        "_sql_stack",
        "_attached",
        "_before",
        "_after",
    )

    def __init__(self) -> None:
        self.request_started = _now()
        self.acquire_seconds: float | None = None
        self.sql_seconds = 0.0
        self._sql_stack: list[float] = []
        self._attached: Any = None
        self._before: Any = None
        self._after: Any = None

    # --- Adquisición de conexión ---

    def begin_acquisition(self) -> float:
        return _now()

    def finish_acquisition(self, started: float) -> None:
        self.acquire_seconds = max(0.0, _now() - started)

    # --- Ejecución de cursores (solo la conexión de esta petición) ---

    def attach(self, connection: Any) -> None:
        """Adjunta listeners a una conexión concreta (no al engine).

        Si un registro falla se intenta retirar lo ya registrado antes de
        propagar el error original. Si el retiro falla puede quedar un listener.
        """
        if connection is None:
            return

        def _before_cursor_execute(_conn, _cursor, _statement, _parameters, _context, _executemany):
            self._sql_stack.append(_now())

        def _after_cursor_execute(_conn, _cursor, _statement, _parameters, _context, _executemany):
            if self._sql_stack:
                self.sql_seconds += max(0.0, _now() - self._sql_stack.pop())

        listeners = (
            ("before_cursor_execute", _before_cursor_execute),
            ("after_cursor_execute", _after_cursor_execute),
        )
        registered: list[tuple[str, Any]] = []
        try:
            for name, handler in listeners:
                sa_event.listen(connection, name, handler)
                registered.append((name, handler))
        except Exception:
            for name, handler in registered:
                try:
                    sa_event.remove(connection, name, handler)
                except Exception:  # noqa: BLE001 - limpieza best-effort
                    pass
            raise

        self._before = _before_cursor_execute
        self._after = _after_cursor_execute
        self._attached = connection

    def detach(self) -> None:
        """Retira todos los listeners. Idempotente y nunca propaga fallos.

        Si un ``remove`` falla se intentan los demás: enmascarar un error de
        negocio o impedir ``db.close()`` sería peor que un listener residual.
        """
        connection = self._attached
        before, after = self._before, self._after
        self._attached = None
        self._before = None
        self._after = None
        self._sql_stack.clear()
        if connection is None:
            return
        for name, handler in (
            ("before_cursor_execute", before),
            ("after_cursor_execute", after),
        ):
            if handler is None:
                continue
            try:
                sa_event.remove(connection, name, handler)
            except Exception:  # noqa: BLE001 - limpieza best-effort
                pass

    def has_active_listeners(self) -> bool:
        return self._attached is not None

    # --- Salida ---

    def request_seconds(self) -> float:
        return max(0.0, _now() - self.request_started)

    def server_timing_header(self) -> str:
        request_ms = self.request_seconds() * 1000.0
        connection_ms = (self.acquire_seconds or 0.0) * 1000.0
        sql_ms = self.sql_seconds * 1000.0
        return (
            f"{REQUEST_METRIC};dur={request_ms:.3f}, "
            f"{CONNECTION_METRIC};dur={connection_ms:.3f}, "
            f"{SQL_METRIC};dur={sql_ms:.3f}"
        )


def collector_from_request(request: Any) -> SummaryTiming | None:
    """Obtiene el acumulador del estado de la petición, si existe."""
    return getattr(request.state, STATE_KEY, None)


def _is_target(scope: dict) -> bool:
    return scope.get("type") == "http" and scope.get("method") == "GET" and scope.get("path") == TARGET_PATH


class SummaryTimingMiddleware:
    """Middleware ASGI que mide solo la ruta y el flag configurados.

    Con el flag apagado o fuera de la ruta exacta no crea acumulador ni agrega
    cabecera: la petición pasa sin instrumentación.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if not _is_target(scope) or not get_settings().summary_timing_enabled:
            await self.app(scope, receive, send)
            return

        collector = SummaryTiming()
        scope.setdefault("state", {})[STATE_KEY] = collector

        async def _send(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.append(_HEADER_NAME, collector.server_timing_header())
            await send(message)

        await self.app(scope, receive, _send)
