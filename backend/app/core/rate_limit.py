"""Rate limiting ligero en memoria para la marcación pública.

Objetivo (spec §52): proteger los endpoints sin autenticación (/identify,
/check-in, /check-out) contra abuso básico, sin añadir dependencias pesadas
(Redis, etc.). Es un límite por IP con ventana deslizante aproximada.

NOTA: es por proceso (uvicorn single-worker). Para múltiples workers se
requeriría un store compartido (Redis); por ahora cumple el MVP.
"""

import time
from collections import defaultdict, deque


class RateLimiter:
    """Ventana deslizante simple: máx `limit` peticiones por `window_seconds`."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self._hits[key]

        # Sacar las peticiones que ya salieron de la ventana.
        while q and now - q[0] > self.window:
            q.popleft()

        if len(q) >= self.limit:
            return False

        q.append(now)
        return True

    def reset(self) -> None:
        """Vacía el estado (para tests)."""
        self._hits.clear()


def client_ip(request) -> str:
    """IP del cliente, respetando X-Forwarded-For (Railway proxy)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
