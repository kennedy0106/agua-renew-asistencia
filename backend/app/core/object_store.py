"""Almacén privado de evidencias (S3 compatible: R2, MinIO u otro endpoint).

Las fotos no se publican. El frontend solo las obtiene por la API autorizada.

Tiempos del cliente: conexión 3 s, lectura 8 s, 2 intentos totales
(modo standard de botocore, ``total_max_attempts``). Eso cubre una
operación del SDK; una marcación puede hacer varias llamadas de red
y esperar locks, así que no es un plazo máximo de toda la petición.
"""

from __future__ import annotations

from dataclasses import dataclass

import boto3
from botocore.client import Config
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)

from app.core.config import get_settings

_store: "ObjectStore | None" = None

CONNECT_TIMEOUT_SECONDS = 3
READ_TIMEOUT_SECONDS = 8
MAX_TOTAL_ATTEMPTS = 2

_UNAVAILABLE_ERRORS = (
    EndpointConnectionError,
    ConnectTimeoutError,
    ReadTimeoutError,
    ConnectionClosedError,
    ConnectionError,
    TimeoutError,
)


class ObjectStoreError(RuntimeError):
    """Almacén de objetos ausente o rechazado."""


class ObjectNotFoundError(ObjectStoreError):
    """El objeto no existe (NoSuchKey / 404 real)."""


class ObjectStoreUnavailableError(ObjectStoreError):
    """Timeout, red, 5xx o permisos insuficientes."""


class ObjectIntegrityError(ObjectStoreError):
    """Hash, tamaño o ubicación incoherentes."""


class ObjectAlreadyExistsError(ObjectStoreError):
    """PUT condicional rechazado: la clave ya tiene contenido."""


@dataclass(frozen=True)
class ObjectStoreSettings:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    region: str
    create_bucket: bool


def _error_code(exc: ClientError) -> str:
    return str((exc.response or {}).get("Error", {}).get("Code") or "")


def _http_status(exc: ClientError) -> int:
    return int((exc.response or {}).get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)


def _is_not_found(exc: ClientError) -> bool:
    code = _error_code(exc)
    status_code = _http_status(exc)
    return code in {"404", "NoSuchKey", "NoSuchBucket", "NotFound", "404 Not Found"} or status_code == 404


def _is_access_denied(exc: ClientError) -> bool:
    code = _error_code(exc)
    status_code = _http_status(exc)
    return code in {"403", "AccessDenied", "AllAccessDisabled", "UnauthorizedAccess"} or status_code == 403


def _is_precondition(exc: ClientError) -> bool:
    code = _error_code(exc)
    status_code = _http_status(exc)
    return code in {"PreconditionFailed", "412"} or status_code == 412


def _unavailable(exc: BaseException) -> ObjectStoreUnavailableError:
    return ObjectStoreUnavailableError(str(exc) or exc.__class__.__name__)


class ObjectStore:
    def __init__(self, settings: ObjectStoreSettings) -> None:
        self.bucket = settings.bucket
        self._create_bucket = settings.create_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.endpoint,
            aws_access_key_id=settings.access_key,
            aws_secret_access_key=settings.secret_key,
            region_name=settings.region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                connect_timeout=CONNECT_TIMEOUT_SECONDS,
                read_timeout=READ_TIMEOUT_SECONDS,
                retries={"total_max_attempts": MAX_TOTAL_ATTEMPTS, "mode": "standard"},
            ),
        )

    def verify_ready(self) -> None:
        """Comprueba el bucket precreado. Nunca crea recursos ante 403."""
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except ClientError as exc:
            if _is_access_denied(exc):
                raise ObjectStoreUnavailableError("Acceso denegado al bucket de evidencias") from exc
            if _is_not_found(exc):
                raise ObjectStoreError(
                    f"El bucket {self.bucket} no existe. Aprovisionarlo fuera de la aplicación."
                ) from exc
            raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc

    def create_bucket_if_missing(self) -> None:
        if not self._create_bucket:
            raise ObjectStoreError("Aprovisionamiento de bucket deshabilitado")
        try:
            self._client.head_bucket(Bucket=self.bucket)
            return
        except ClientError as exc:
            if _is_access_denied(exc):
                raise ObjectStoreUnavailableError("Acceso denegado al bucket de evidencias") from exc
            if not _is_not_found(exc):
                raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc
        try:
            self._client.create_bucket(Bucket=self.bucket)
        except ClientError as exc:
            raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc

    def put_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str,
        *,
        bucket: str | None = None,
        if_none_match: bool = True,
    ) -> None:
        target = bucket or self.bucket
        kwargs: dict = {
            "Bucket": target,
            "Key": key,
            "Body": data,
            "ContentType": content_type,
        }
        if if_none_match:
            kwargs["IfNoneMatch"] = "*"
        try:
            self._client.put_object(**kwargs)
        except ClientError as exc:
            if _is_precondition(exc):
                raise ObjectAlreadyExistsError(key) from exc
            raise _unavailable(exc) from exc
        except TypeError as exc:
            if if_none_match:
                raise ObjectStoreError(
                    "El almacén no admite escritura condicional IfNoneMatch; no se sustituyó el objeto"
                ) from exc
            raise
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc

    def get_bytes(self, key: str, *, bucket: str | None = None) -> bytes:
        target = bucket or self.bucket
        body = None
        try:
            response = self._client.get_object(Bucket=target, Key=key)
            body = response["Body"]
            return body.read()
        except ClientError as exc:
            if _is_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc
        finally:
            if body is not None:
                body.close()

    def head_object(self, key: str, *, bucket: str | None = None) -> dict:
        target = bucket or self.bucket
        try:
            return self._client.head_object(Bucket=target, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc

    def delete(self, key: str, *, bucket: str | None = None) -> str:
        """Idempotente: 'deleted' o 'already_absent'. 403/timeout no es éxito."""
        target = bucket or self.bucket
        try:
            self.head_object(key, bucket=target)
        except ObjectNotFoundError:
            return "already_absent"
        try:
            self._client.delete_object(Bucket=target, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                return "already_absent"
            raise _unavailable(exc) from exc
        except _UNAVAILABLE_ERRORS as exc:
            raise _unavailable(exc) from exc
        return "deleted"

    def exists(self, key: str, *, bucket: str | None = None) -> bool:
        try:
            self.head_object(key, bucket=bucket)
            return True
        except ObjectNotFoundError:
            return False


def settings_from_env() -> ObjectStoreSettings:
    settings = get_settings()
    endpoint = (settings.object_store_endpoint or "").strip()
    access_key = (settings.object_store_access_key or "").strip()
    secret_key = (settings.object_store_secret_key or "").strip()
    bucket = (settings.object_store_bucket or "").strip()
    region = (settings.object_store_region or "us-east-1").strip() or "us-east-1"
    if not endpoint or not access_key or not secret_key or not bucket:
        raise ObjectStoreError(
            "Almacén de objetos no configurado. Defina OBJECT_STORE_ENDPOINT, "
            "OBJECT_STORE_ACCESS_KEY, OBJECT_STORE_SECRET_KEY y OBJECT_STORE_BUCKET."
        )
    return ObjectStoreSettings(
        endpoint=endpoint.rstrip("/"),
        access_key=access_key,
        secret_key=secret_key,
        bucket=bucket,
        region=region,
        create_bucket=bool(settings.object_store_create_bucket),
    )


def get_object_store() -> ObjectStore:
    global _store
    if _store is None:
        candidate = ObjectStore(settings_from_env())
        candidate.verify_ready()
        _store = candidate
    return _store


def provision_test_bucket() -> ObjectStore:
    """Crea el bucket solo cuando el harness lo autoriza (tests / verify_local)."""
    global _store
    settings = settings_from_env()
    candidate = ObjectStore(settings)
    candidate.create_bucket_if_missing()
    candidate.verify_ready()
    _store = candidate
    return candidate


def reset_object_store() -> None:
    global _store
    _store = None


def evidence_object_key(employee_id: str, nonce: str) -> str:
    return f"attendance/{employee_id}/{nonce}.jpg"
