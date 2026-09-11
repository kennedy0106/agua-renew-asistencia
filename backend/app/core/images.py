"""Validación y normalización de fotografías de marcación."""

from __future__ import annotations

import hashlib
from io import BytesIO

from fastapi import HTTPException, status
from PIL import Image, UnidentifiedImageError

MIN_WIDTH = 320
MIN_HEIGHT = 240
MAX_WIDTH = 4000
MAX_HEIGHT = 4000
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_SIDE = 1280
JPEG_QUALITY = 80
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}


def verify_and_normalize(raw: bytes) -> tuple[bytes, str, str]:
    """Devuelve JPEG recodificado, content-type y sha256. Rechaza no-imágenes."""
    if len(raw) < 32 or len(raw) > MAX_INPUT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El tamaño de la foto no es válido",
        )
    try:
        image = Image.open(BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El archivo no es una imagen válida",
        ) from exc
    fmt = (image.format or "").upper()
    if fmt not in ALLOWED_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La foto debe ser JPEG, PNG o WebP",
        )
    width, height = image.size
    if width < MIN_WIDTH or height < MIN_HEIGHT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La foto es demasiado pequeña para usarse como evidencia",
        )
    if width > MAX_WIDTH or height > MAX_HEIGHT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La foto supera las dimensiones permitidas",
        )
    rgb = image.convert("RGB")
    longest = max(rgb.size)
    if longest > MAX_OUTPUT_SIDE:
        scale = MAX_OUTPUT_SIDE / longest
        rgb = rgb.resize((int(rgb.size[0] * scale), int(rgb.size[1] * scale)), Image.Resampling.LANCZOS)
    buffer = BytesIO()
    rgb.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    normalized = buffer.getvalue()
    digest = hashlib.sha256(normalized).hexdigest()
    return normalized, "image/jpeg", digest
