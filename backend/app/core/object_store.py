"""Almacén privado de evidencias (S3 compatible: R2, MinIO u otro endpoint).

Las fotos no se publican. El frontend solo las obtiene por la API autorizada.
"""

from __future__ import annotations

from dataclasses import dataclass

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.core.config import get_settings

_store: "ObjectStore | None" = None


class ObjectStoreError(RuntimeError):
    """Almacén de objetos ausente o rechazado."""


@dataclass(frozen=True)
class ObjectStoreSettings:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    region: str


class ObjectStore:
    def __init__(self, settings: ObjectStoreSettings) -> None:
        self.bucket = settings.bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.endpoint,
            aws_access_key_id=settings.access_key,
            aws_secret_access_key=settings.secret_key,
            region_name=settings.region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self.bucket)

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get_bytes(self, key: str) -> bytes:
        response = self._client.get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=key)

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError:
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
    )


def get_object_store() -> ObjectStore:
    global _store
    if _store is None:
        _store = ObjectStore(settings_from_env())
        _store.ensure_bucket()
    return _store


def reset_object_store() -> None:
    global _store
    _store = None


def evidence_object_key(employee_id: str, nonce: str) -> str:
    return f"attendance/{employee_id}/{nonce}.jpg"
