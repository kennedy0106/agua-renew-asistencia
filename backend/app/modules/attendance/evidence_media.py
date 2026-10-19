"""Evidencia fotográfica y dirección aproximada — helpers PUROS.

Este módulo no toca base de datos, almacenamiento, roles, configuración ni
relojes del sistema. Recibe metadatos inmutables ya resueltos por el servicio
de asistencia y devuelve bytes/JSON acotados.

Contenido:

- :func:`reverse_address` — geocodificación inversa opcional (Geoapify) con
  ``urllib`` de la biblioteca estándar, host fijo, sin redirecciones, límites
  de tiempo/tamaño, errores seguros y caché/tasas locales al proceso.
- :func:`render_stamp` — sello visual de la fotografía original (JPEG) con
  gota de marca y banda de metadatos; no modifica los bytes de origen.

Ninguna función escribe ni registra la clave de API, coordenadas precisas,
nombres, DNI ni tokens. Las excepciones de dominio se reportan con
:class:`StampRenderError`.
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
import urllib.parse
import urllib.request
import unicodedata
import warnings
from collections import OrderedDict
from datetime import datetime, timedelta, timezone, tzinfo
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

try:  # Zona oficial del negocio; el respaldo fijo cubre instalaciones sin tzdata.
    from zoneinfo import ZoneInfo

    _LIMA_TZ: tzinfo = ZoneInfo("America/Lima")
except Exception:  # pragma: no cover - sólo si falta tzdata
    _LIMA_TZ = timezone(timedelta(hours=-5), "UTC-05:00")

logger = logging.getLogger(__name__)


class StampRenderError(RuntimeError):
    """El sello no pudo generarse (origen inválido, metadatos o logo ausente).

    Se lanza en lugar de devolver la imagen original: un sello fallido nunca
    debe presentarse como si fuera la fotografía ya sellada.
    """


# --------------------------------------------------------------------------- #
# Dirección aproximada (Geoapify reverse geocoding)
# --------------------------------------------------------------------------- #

_GEOAPIFY_HOST = "api.geoapify.com"
_GEOAPIFY_REVERSE_PATH = "/v1/geocode/reverse"
_GEOAPIFY_ATTRIBUTION = "Powered by Geoapify · © OpenStreetMap contributors"
_GEOAPIFY_USER_AGENT = "agua-renew-attendance/1.0 (+reverse-geocode)"
_REQUEST_TIMEOUT_SECONDS = 4.0
_MAX_RESPONSE_BYTES = 16 * 1024
_MAX_FORMATTED_CHARS = 300

# Salvaguardas locales al proceso (no son cuota de cuenta: ver docs).
_CACHE_PRECISION = 4
_CACHE_MAX_ENTRIES = 256
_CACHE_TTL_SECONDS = 600.0
_MIN_REQUEST_INTERVAL_SECONDS = 0.25
# Tope de admisión: como máximo una llegada espera el intervalo completo. Las
# demás se omiten (None) en lugar de reservar turnos futuros ilimitados, que
# alargarían la espera de una ruta opcional hasta segundos.
_MAX_ADMISSION_WAIT_SECONDS = _MIN_REQUEST_INTERVAL_SECONDS
_MAX_REQUESTS_PER_DAY = 2500
_WINDOW_SECONDS = 86400.0


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Bloquea redirecciones: una clave nunca debe viajar a otro host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def _build_opener() -> urllib.request.OpenerDirector:
    """Abridor sin redirecciones (host fijo, HTTPS únicamente)."""
    return urllib.request.build_opener(_NoRedirectHandler)


_OPENER = _build_opener()

_state_lock = threading.Lock()
_cache: "OrderedDict[tuple[float, float], tuple[float, str]]" = OrderedDict()
_last_send_at: float | None = None
_requests_in_window = 0
_window_started_at: float | None = None


def _monotonic() -> float:
    """Reloj monótono (costura para pruebas deterministas)."""
    return time.monotonic()


def _sleep(seconds: float) -> None:
    """Espera acotada (costura para pruebas deterministas)."""
    time.sleep(seconds)


def _reset_state() -> None:
    """Reinicia caché y contadores locales (higiene de pruebas)."""
    global _last_send_at, _requests_in_window, _window_started_at
    with _state_lock:
        _cache.clear()
        _last_send_at = None
        _requests_in_window = 0
        _window_started_at = None


def _validated_coordinates(latitude, longitude) -> tuple[float, float] | None:
    """Coordenadas finitas dentro de rango; ``None`` si no son utilizables."""
    for value in (latitude, longitude):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not math.isfinite(float(value)):
            return None
    lat = float(latitude)
    lon = float(longitude)
    if lat < -90.0 or lat > 90.0 or lon < -180.0 or lon > 180.0:
        return None
    return lat, lon


def _clean_text(value: str, limit: int) -> str:
    """Quita caracteres de control, colapsa espacios y acota la longitud."""
    cleaned = "".join(char if char.isprintable() else " " for char in value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > limit:
        cleaned = cleaned[: limit - 1].rstrip() + "…"
    return cleaned


def _build_url(latitude: float, longitude: float, api_key: str) -> str:
    """URL fija del proveedor: sólo coordenadas validadas, idioma y clave."""
    query = urllib.parse.urlencode(
        {
            "lat": f"{latitude:.6f}",
            "lon": f"{longitude:.6f}",
            "lang": "es",
            "format": "json",
            "apiKey": api_key,
        }
    )
    return f"https://{_GEOAPIFY_HOST}{_GEOAPIFY_REVERSE_PATH}?{query}"


def _fetch_formatted(latitude: float, longitude: float, api_key: str) -> str | None:
    """Consulta al proveedor. Nunca propaga excepciones ni datos sensibles."""
    request = urllib.request.Request(
        _build_url(latitude, longitude, api_key),
        headers={"Accept": "application/json", "User-Agent": _GEOAPIFY_USER_AGENT},
        method="GET",
    )
    try:
        with _OPENER.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            status = getattr(response, "status", None) or response.getcode()
            if status != 200:
                return None
            headers = getattr(response, "headers", None)
            declared = None
            if headers is not None:
                try:
                    declared = headers.get("Content-Length")
                except Exception:  # pragma: no cover - cabeceras no estándar
                    declared = None
            if declared is not None:
                try:
                    if int(declared) > _MAX_RESPONSE_BYTES:
                        return None
                except (TypeError, ValueError):
                    pass
            payload = response.read(_MAX_RESPONSE_BYTES + 1)
    except Exception as exc:  # el mensaje puede contener URL/clave: sólo el tipo
        logger.warning("reverse_address no disponible (%s)", type(exc).__name__)
        return None
    if not payload or len(payload) > _MAX_RESPONSE_BYTES:
        return None
    try:
        data = json.loads(payload.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    results = data.get("results")
    if not isinstance(results, list) or not results:
        return None
    first = results[0]
    if not isinstance(first, dict):
        return None
    formatted = first.get("formatted")
    if not isinstance(formatted, str):
        return None
    cleaned = _clean_text(formatted, _MAX_FORMATTED_CHARS)
    return cleaned or None


def _cache_get(key: tuple[float, float], now: float) -> str | None:
    """Entrada vigente de caché. Requiere ``_state_lock``."""
    entry = _cache.get(key)
    if entry is None:
        return None
    stored_at, value = entry
    if now - stored_at > _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return value


def _cache_put(key: tuple[float, float], value: str, now: float) -> None:
    """Guarda un resultado acotando entradas. Requiere ``_state_lock``."""
    _cache[key] = (now, value)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


def _reserve_request(now: float) -> float | None:
    """Reserva una consulta y devuelve la espera necesaria.

    ``None`` cuando el presupuesto local diario se agotó **o** cuando el cupo
    inmediato está ocupado: una llegada simultánea extra se omite en lugar de
    acumular esperas futuras. Una admisión omitida no consume presupuesto ni
    reserva tiempo. Requiere ``_state_lock``; la espera devuelta nunca supera
    ``_MAX_ADMISSION_WAIT_SECONDS`` y se aplica fuera del candado.
    """
    global _last_send_at, _requests_in_window, _window_started_at
    if _window_started_at is None or now - _window_started_at >= _WINDOW_SECONDS:
        _window_started_at = now
        _requests_in_window = 0
    if _requests_in_window >= _MAX_REQUESTS_PER_DAY:
        return None
    next_allowed = (
        _last_send_at + _MIN_REQUEST_INTERVAL_SECONDS if _last_send_at is not None else now
    )
    wait = max(0.0, next_allowed - now)
    if wait > _MAX_ADMISSION_WAIT_SECONDS:
        return None
    _last_send_at = now + wait
    _requests_in_window += 1
    return wait


def _address_payload(formatted: str) -> dict[str, str]:
    return {"formatted": formatted, "attribution": _GEOAPIFY_ATTRIBUTION}


def reverse_address(latitude: float, longitude: float, *, api_key: str = "") -> dict | None:
    """Dirección aproximada para un punto, o ``None`` si no está disponible.

    Sin ``api_key`` no hay red, caché ni resultado: la ausencia de clave es un
    caso normal, no un error. Con clave, sólo se consulta al host fijo del
    proveedor por HTTPS, con tiempo de espera y tamaño de respuesta acotados,
    sin redirecciones y con errores silenciosos (cuota, red, respuesta
    malformada). Devuelve ``{"formatted", "attribution"}`` con textos
    acotados; nunca devuelve las coordenadas del geocodificador ni modifica
    las coordenadas originales del llamador. Si ya hay una consulta en curso,
    devuelve ``None`` en lugar de esperar turnos futuros: la espera máxima es
    acotada (``_MAX_ADMISSION_WAIT_SECONDS``).
    """
    key = api_key.strip() if isinstance(api_key, str) else ""
    if not key:
        return None
    coords = _validated_coordinates(latitude, longitude)
    if coords is None:
        logger.warning("reverse_address omitido: coordenadas no utilizables")
        return None
    cache_key = (round(coords[0], _CACHE_PRECISION), round(coords[1], _CACHE_PRECISION))
    now = _monotonic()
    with _state_lock:
        cached = _cache_get(cache_key, now)
        if cached is not None:
            return _address_payload(cached)
        wait = _reserve_request(now)
        if wait is None:
            logger.warning(
                "reverse_address omitido: cupo local no disponible "
                "(presupuesto agotado o consulta en curso)"
            )
            return None
    if wait > 0:
        _sleep(wait)
    formatted = _fetch_formatted(coords[0], coords[1], key)
    if formatted is None:
        return None
    with _state_lock:
        _cache_put(cache_key, formatted, _monotonic())
    return _address_payload(formatted)


# --------------------------------------------------------------------------- #
# Sello visual de la evidencia
# --------------------------------------------------------------------------- #

_BRAND_ASSET = Path(__file__).resolve().parents[2] / "assets" / "brand" / "agua-renew-drop.png"

# El origen ya llega normalizado por app.core.images (<= 1280 px, <= 2 MB);
# estos límites son defensa adicional, alineados con los del núcleo.
_MAX_INPUT_BYTES = 2 * 1024 * 1024
_MAX_INPUT_PIXELS = 4000 * 4000
# Lado mayor de la FOTOGRAFÍA (sin la banda inferior, que se suma aparte).
_MAX_OUTPUT_SIDE = 2048
_ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}

_MAX_NAME_CHARS = 60
_MAX_CODE_CHARS = 32
_MAX_ADDRESS_CHARS = 300
_MAX_EVIDENCE_CHARS = 64
_MAX_EVENT_CHARS = 24

_MAX_LINES_PER_FIELD = 3
_MAX_STAMP_LINES = 12
_MAX_LOGO_PX = 160
_JPEG_QUALITY = 92

# Fuente bitmap incluida en Pillow ("load_default_imagefont"): cubre ISO-8859-1,
# así que conserva los acentos españoles y la eñe. La fuente vectorial de
# ``load_default(size=...)`` (Aileron) no los incluye y los dibujaría como cajas.
_TEXT_LINE_PX = 15
_MAX_TEXT_SCALE = 3
_TEXT_PAD_PX = 8
_TEXT_ACCENT_PX = 3

# Tope real del JPEG: fotografía acotada + banda inferior máxima (12 líneas
# a la escala mayor). A escalas menores caben más líneas dentro de los mismos
# píxeles; no se pierden créditos por aplicarles el presupuesto de escala 3.
_MAX_BAND_HEIGHT = (
    2 * _TEXT_PAD_PX + _TEXT_ACCENT_PX + _MAX_STAMP_LINES * _TEXT_LINE_PX
) * _MAX_TEXT_SCALE
_MAX_OUTPUT_HEIGHT = _MAX_OUTPUT_SIDE + _MAX_BAND_HEIGHT

# Caracteres fuera de Latin-1 con su equivalente legible.
_TEXT_REPLACEMENTS = {
    "…": "...",
    "—": "-",
    "–": "-",
    "’": "'",
    "‘": "'",
    "“": '"',
    "”": '"',
    "•": "·",
}

_FOOTER_BG = (15, 23, 42)
_FOOTER_FG = (241, 245, 249)
_ACCENT = (14, 165, 233)
_ACCENT_TEXT = (125, 211, 252)

_EVENT_LABELS = {
    "CHECK_IN": "Entrada",
    "CHECK_OUT": "Salida",
    "ENTRY": "Entrada",
    "EXIT": "Salida",
    "IN": "Entrada",
    "OUT": "Salida",
    "ENTRADA": "Entrada",
    "SALIDA": "Salida",
}


def _event_label(event_type) -> str:
    """Etiqueta en español del evento; texto limpio si es desconocido."""
    if not isinstance(event_type, str):
        raise StampRenderError("event_type debe ser texto")
    key = event_type.strip().upper()
    return _EVENT_LABELS.get(key) or (_clean_text(event_type, _MAX_EVENT_CHARS) or "Marcación")


def _format_marked_at(marked_at: datetime) -> str:
    """Hora oficial del argumento, presentada en Peru con segundos y zona."""
    if not isinstance(marked_at, datetime):
        raise StampRenderError("marked_at debe ser un datetime")
    moment = marked_at if marked_at.tzinfo is not None else marked_at.replace(tzinfo=timezone.utc)
    local = moment.astimezone(_LIMA_TZ)
    total = int((local.utcoffset() or timedelta(0)).total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    zone = f"UTC{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}"
    return f"{local:%d/%m/%Y %H:%M:%S} (America/Lima, {zone})"


def _stamp_lines(
    *,
    employee_name: str,
    employee_code: str,
    event_type: str,
    marked_at: datetime,
    latitude: float,
    longitude: float,
    accuracy_m: float,
    address: str | None,
    evidence_id: str,
) -> list[str]:
    """Valida los metadatos y compone las líneas exactas del sello.

    Función pura de los argumentos: no lee relojes ni metadatos del navegador.
    """
    if not isinstance(employee_name, str) or not isinstance(employee_code, str):
        raise StampRenderError("nombre y código del trabajador deben ser texto")
    if not isinstance(evidence_id, str):
        raise StampRenderError("evidence_id debe ser texto")
    coords = _validated_coordinates(latitude, longitude)
    if coords is None:
        raise StampRenderError("coordenadas inválidas para el sello")
    if (
        isinstance(accuracy_m, bool)
        or not isinstance(accuracy_m, (int, float))
        or not math.isfinite(float(accuracy_m))
        or float(accuracy_m) < 0
    ):
        raise StampRenderError("accuracy_m debe ser un número finito no negativo")
    if address is not None and not isinstance(address, str):
        raise StampRenderError("address debe ser texto o None")

    name = _clean_text(employee_name, _MAX_NAME_CHARS) or "Trabajador"
    code = _clean_text(employee_code, _MAX_CODE_CHARS) or "sin código"
    approximate = _clean_text(address, _MAX_ADDRESS_CHARS) if address else ""
    reference = _clean_text(evidence_id, _MAX_EVIDENCE_CHARS) or "sin referencia"

    lines = [
        f"{name} · Código interno: {code}",
        f"{_event_label(event_type)} · {_format_marked_at(marked_at)}",
        f"GPS original: {coords[0]:.6f}, {coords[1]:.6f} (±{float(accuracy_m):.1f} m)",
        f"Dirección aprox.: {approximate}" if approximate else "Dirección aprox.: no disponible",
        f"Evidencia: {reference}",
    ]
    if approximate:
        # Atribución obligatoria cuando se usa la dirección del proveedor.
        lines.append(_GEOAPIFY_ATTRIBUTION)
    return lines


def _load_text_font() -> ImageFont.ImageFont:
    """Fuente incluida en Pillow con cobertura Latin-1 (acentos y eñe).

    Requiere Pillow >= 10.1 (``pyproject.toml`` ya exige >= 11).
    """
    return ImageFont.load_default_imagefont()


def _to_latin1(text: str) -> str:
    """Ajusta el texto a la cobertura Latin-1 de la fuente del sello.

    Conserva los acentos españoles tal cual. Sólo sustituye signos tipográficos
    por equivalentes y translitera caracteres que la fuente no puede dibujar.
    """
    parts: list[str] = []
    for char in text:
        replacement = _TEXT_REPLACEMENTS.get(char)
        if replacement is not None:
            parts.append(replacement)
            continue
        try:
            char.encode("latin-1")
        except UnicodeEncodeError:
            plain = "".join(
                piece
                for piece in unicodedata.normalize("NFKD", char)
                if not unicodedata.combining(piece) and piece.isprintable()
            )
            try:
                plain.encode("latin-1")
            except UnicodeEncodeError:
                plain = ""
            parts.append(plain if plain else "?")
        else:
            parts.append(char)
    return "".join(parts)


def _load_brand() -> Image.Image:
    """Carga el PNG de marca (propiedad del repositorio) como RGBA."""
    try:
        with Image.open(_BRAND_ASSET) as image:
            return image.convert("RGBA").copy()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise StampRenderError("el logo de marca no está disponible") from exc


def _load_base(original: bytes) -> Image.Image:
    """Decodifica el origen, corrige orientación EXIF y acota dimensiones."""
    if not isinstance(original, (bytes, bytearray)) or len(original) < 32 or len(original) > _MAX_INPUT_BYTES:
        raise StampRenderError("la fotografía original no tiene un tamaño válido")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(BytesIO(bytes(original)))
            fmt = (image.format or "").upper()
            if fmt not in _ALLOWED_FORMATS:
                raise StampRenderError("formato de imagen no admitido para el sello")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > _MAX_INPUT_PIXELS:
                raise StampRenderError("dimensiones de la fotografía fuera de rango")
            image.load()
    except StampRenderError:
        raise
    except Exception as exc:
        raise StampRenderError("la fotografía original no es una imagen legible") from exc

    upright = ImageOps.exif_transpose(image) or image
    rgb = upright.convert("RGB")
    longest = max(rgb.size)
    if longest > _MAX_OUTPUT_SIDE:
        scale = _MAX_OUTPUT_SIDE / longest
        rgb = rgb.resize(
            (max(1, int(rgb.size[0] * scale)), max(1, int(rgb.size[1] * scale))),
            Image.Resampling.LANCZOS,
        )
    return rgb


def _fit_with_ellipsis(draw: ImageDraw.ImageDraw, text: str, font, max_width: float) -> str:
    """Recorta el texto para que quepa con puntos suspensivos."""
    trimmed = text
    while trimmed and draw.textlength(trimmed + "...", font=font) > max_width:
        trimmed = trimmed[:-1]
    return trimmed + "..."


def _wrap_text(
    draw: ImageDraw.ImageDraw, text: str, font, max_width: float, max_lines: int
) -> list[str]:
    """Ajusta el texto al ancho, acotando el número de líneas."""
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    truncated = False
    for word in words:
        candidate = f"{current} {word}".strip()
        if not current or draw.textlength(candidate, font=font) <= max_width:
            current = candidate
            continue
        lines.append(current)
        current = word
        if len(lines) >= max_lines:
            truncated = True
            current = ""
            break
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        truncated = True
        lines = lines[:max_lines]
    if truncated and lines:
        lines[-1] = _fit_with_ellipsis(draw, lines[-1], font, max_width)
    return lines


def _paste_brand(canvas: Image.Image, logo: Image.Image, base_height: int) -> None:
    """Pega la gota de marca con una placa clara, en la esquina superior derecha."""
    limit = max(24, min(canvas.width // 6, base_height // 5, _MAX_LOGO_PX))
    ratio = min(limit / max(1, logo.width), limit / max(1, logo.height))
    target = (max(1, int(logo.width * ratio)), max(1, int(logo.height * ratio)))
    scaled = logo.resize(target, Image.Resampling.LANCZOS)
    margin = max(8, canvas.width // 50)
    plate_pad = max(4, target[0] // 8)
    x = max(0, canvas.width - target[0] - margin)
    y = margin
    plate_w = target[0] + 2 * plate_pad
    plate_h = target[1] + 2 * plate_pad
    plate = Image.new("RGBA", (plate_w, plate_h), (255, 255, 255, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        [0, 0, plate_w - 1, plate_h - 1],
        radius=max(4, plate_pad),
        fill=(255, 255, 255, 190),
    )
    canvas.paste(plate, (x - plate_pad, y - plate_pad), plate)
    canvas.paste(scaled, (x, y), scaled)


def _compose(base: Image.Image, lines: list[str], logo: Image.Image) -> Image.Image:
    """Extiende el lienzo hacia abajo y dibuja gota y metadatos.

    El texto se dibuja con la fuente bitmap incluida y luego se amplía por un
    factor entero (vecino más cercano) para mantenerlo legible sin depender de
    fuentes del sistema.
    """
    width, base_height = base.size
    font = _load_text_font()
    # ~1.7 % del ancho por línea de texto: legible sin dominar la fotografía.
    scale = max(1, min(_MAX_TEXT_SCALE, width // 480))
    columns = max(40, width // scale)
    max_text_width = max(20, columns - 2 * _TEXT_PAD_PX)
    measure = ImageDraw.Draw(Image.new("RGB", (4, 4)))

    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(
            _wrap_text(measure, _to_latin1(line), font, max_text_width, _MAX_LINES_PER_FIELD)
        )
    # El límite es físico: una foto estrecha usa escala 1 y puede aprovechar
    # más filas sin aumentar la banda máxima ni recortar referencias/créditos.
    max_lines = (
        _MAX_BAND_HEIGHT // scale - 2 * _TEXT_PAD_PX - _TEXT_ACCENT_PX
    ) // _TEXT_LINE_PX
    truncated = len(wrapped) > max_lines
    if truncated:
        wrapped = wrapped[:max_lines]
    if truncated and wrapped:
        wrapped[-1] = _fit_with_ellipsis(measure, wrapped[-1], font, max_text_width)

    band_height = 2 * _TEXT_PAD_PX + _TEXT_ACCENT_PX + len(wrapped) * _TEXT_LINE_PX
    canvas = Image.new("RGB", (width, base_height + band_height * scale), _FOOTER_BG)
    canvas.paste(base, (0, 0))
    _paste_brand(canvas, logo, base_height)

    band = Image.new("RGB", (columns, band_height), _FOOTER_BG)
    draw = ImageDraw.Draw(band)
    draw.rectangle([0, 0, columns, _TEXT_ACCENT_PX - 1], fill=_ACCENT)
    y = _TEXT_ACCENT_PX + _TEXT_PAD_PX
    for index, line in enumerate(wrapped):
        colour = _ACCENT_TEXT if index == 1 else _FOOTER_FG
        draw.text((_TEXT_PAD_PX, y), line, font=font, fill=colour)
        y += _TEXT_LINE_PX
    canvas.paste(band.resize((columns * scale, band_height * scale), Image.Resampling.NEAREST), (0, base_height))
    return canvas


def render_stamp(
    original: bytes,
    *,
    employee_name: str,
    employee_code: str,
    event_type: str,
    marked_at: datetime,
    latitude: float,
    longitude: float,
    accuracy_m: float,
    address: str | None,
    evidence_id: str,
) -> bytes:
    """Devuelve un JPEG sellado a partir de la fotografía original.

    - La hora oficial es ``marked_at`` (argumento inmutable): nunca se usa el
      reloj del dispositivo, de la subida ni de la base de datos.
    - Se imprime el código interno del trabajador, no el DNI.
    - La gota de marca va en la esquina superior derecha sobre una placa
      clara; los metadatos van en una banda inferior que extiende el lienzo,
      por lo que no se tapa el rostro. El texto usa la fuente bitmap incluida
      en Pillow (cobertura Latin-1: acentos y eñe legibles) ampliada por un
      factor entero.
    - La atribución de Geoapify/OpenStreetMap sólo aparece cuando se usó la
      dirección aproximada.
    - El lado mayor de la fotografía se acota a ``_MAX_OUTPUT_SIDE`` (2048 px)
      y la banda inferior a 597 px. Caben 12 líneas a escala máxima y más
      filas a escalas menores sin superar ``_MAX_OUTPUT_HEIGHT``
      (2048 + 597 = 2645 px de alto). La banda y el logo nunca se recortan.
    - Los bytes de ``original`` nunca se modifican y el resultado es
      determinista para los mismos metadatos.

    Lanza :class:`StampRenderError` si los metadatos o la imagen no son
    utilizables, o si falta el logo de marca: nunca devuelve la imagen
    original como si estuviera sellada.
    """
    lines = _stamp_lines(
        employee_name=employee_name,
        employee_code=employee_code,
        event_type=event_type,
        marked_at=marked_at,
        latitude=latitude,
        longitude=longitude,
        accuracy_m=accuracy_m,
        address=address,
        evidence_id=evidence_id,
    )
    base = _load_base(original)
    logo = _load_brand()
    try:
        canvas = _compose(base, lines, logo)
        buffer = BytesIO()
        canvas.save(buffer, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
    except StampRenderError:
        raise
    except Exception as exc:
        raise StampRenderError("no se pudo generar la fotografía sellada") from exc
    return buffer.getvalue()
