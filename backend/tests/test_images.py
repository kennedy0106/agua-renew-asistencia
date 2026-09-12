"""Rechazos controlados de fotografías de marcación."""

from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image

from app.core.images import verify_and_normalize
from tests.image_helpers import invalid_jpeg_b64, jpeg_exif_orientation_6_b64, valid_jpeg_b64, valid_png_b64


def _b64_png(*, width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), (8, 8, 8))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_imagen_valida_se_normaliza():
    import base64

    raw = base64.b64decode(valid_jpeg_b64())
    normalized, ctype, digest = verify_and_normalize(raw)
    assert ctype == "image/jpeg"
    assert len(digest) == 64
    assert normalized[:2] == b"\xff\xd8"


def test_imagen_corrupta_422():
    import base64

    raw = base64.b64decode(invalid_jpeg_b64())
    with pytest.raises(HTTPException) as exc:
        verify_and_normalize(raw)
    assert exc.value.status_code == 422


def test_imagen_demasiado_pequena_422():
    raw = _b64_png(width=100, height=80)
    with pytest.raises(HTTPException) as exc:
        verify_and_normalize(raw)
    assert exc.value.status_code == 422
    assert "pequeña" in str(exc.value.detail).lower()


def test_dimensiones_excesivas_422():
    raw = _b64_png(width=4001, height=240)
    with pytest.raises(HTTPException) as exc:
        verify_and_normalize(raw)
    assert exc.value.status_code == 422


def test_decompression_bomb_warning_422():
    raw = _b64_png(width=4001, height=4000)
    with pytest.raises(HTTPException) as exc:
        verify_and_normalize(raw)
    assert exc.value.status_code == 422


def test_decompression_bomb_error_422():
    raw = _b64_png(width=6000, height=6000)
    with pytest.raises(HTTPException) as exc:
        verify_and_normalize(raw)
    assert exc.value.status_code == 422


def test_exif_transpose_antes_de_hash():
    import base64

    raw = base64.b64decode(jpeg_exif_orientation_6_b64())
    normalized, _ctype, _digest = verify_and_normalize(raw)
    decoded = Image.open(BytesIO(normalized))
    assert decoded.size[1] > decoded.size[0]


def test_png_valido_se_acepta():
    import base64

    raw = base64.b64decode(valid_png_b64())
    _normalized, ctype, _digest = verify_and_normalize(raw)
    assert ctype == "image/jpeg"
