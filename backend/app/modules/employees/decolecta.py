"""Cliente mínimo para la consulta RENIEC de DeColecta.

El módulo no registra la clave ni los datos personales devueltos por el
proveedor. Su uso está limitado al endpoint administrativo de alta.
"""

import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class DeColectaError(Exception):
    """Error controlado del proveedor, sin detalles sensibles."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        super().__init__(kind)


@dataclass(frozen=True)
class DniIdentity:
    dni: str
    first_name: str
    first_last_name: str
    second_last_name: str | None
    full_name: str


def lookup_dni(*, dni: str, api_key: str, timeout_seconds: float) -> DniIdentity:
    """Consulta una vez el DNI solicitado y valida el contrato recibido."""
    query = urlencode({"numero": dni})
    request = Request(
        f"https://api.decolecta.com/v1/reniec/dni?{query}",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - URL fija del proveedor
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 400 or exc.code == 404:
            raise DeColectaError("not_found") from exc
        if exc.code == 401 or exc.code == 403:
            raise DeColectaError("authentication") from exc
        if exc.code == 429:
            raise DeColectaError("rate_limited") from exc
        raise DeColectaError("upstream") from exc
    except TimeoutError as exc:
        raise DeColectaError("timeout") from exc
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise DeColectaError("timeout") from exc
        raise DeColectaError("upstream") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeColectaError("invalid_payload") from exc

    if not isinstance(payload, dict):
        raise DeColectaError("invalid_payload")

    document_number = payload.get("document_number")
    first_name = payload.get("first_name")
    first_last_name = payload.get("first_last_name")
    second_last_name = payload.get("second_last_name")
    full_name = payload.get("full_name")
    if (
        document_number != dni
        or not isinstance(first_name, str)
        or not first_name.strip()
        or not isinstance(first_last_name, str)
        or not first_last_name.strip()
        or (second_last_name is not None and not isinstance(second_last_name, str))
        or not isinstance(full_name, str)
        or not full_name.strip()
    ):
        raise DeColectaError("invalid_payload")
    return DniIdentity(
        dni=document_number,
        first_name=first_name.strip(),
        first_last_name=first_last_name.strip(),
        second_last_name=second_last_name.strip() if second_last_name else None,
        full_name=full_name.strip(),
    )
