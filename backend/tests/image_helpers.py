"""JPEG de prueba que cumple los mínimos de evidencia (320x240)."""

import base64
from io import BytesIO

from PIL import Image


def valid_jpeg_b64(*, width: int = 320, height: int = 240, color=(40, 80, 120)) -> str:
    image = Image.new("RGB", (width, height), color)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=80)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def invalid_jpeg_b64() -> str:
    return base64.b64encode(b"x" * 64).decode("ascii")


def valid_png_b64(*, width: int = 320, height: int = 240) -> str:
    image = Image.new("RGB", (width, height), (12, 40, 90))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def jpeg_exif_orientation_6_b64(*, width: int = 640, height: int = 400) -> str:
    """JPEG apaisado con orientación EXIF 6 (debe leerse en vertical)."""
    image = Image.new("RGB", (width, height), (10, 200, 30))
    exif = Image.Exif()
    exif[0x0112] = 6
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=80, exif=exif)
    return base64.b64encode(buffer.getvalue()).decode("ascii")
