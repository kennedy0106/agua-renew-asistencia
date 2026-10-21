"""Pruebas del módulo puro de evidencia: dirección aproximada y sello de foto.

``app.modules.attendance.evidence_media`` es puro: no toca base de datos,
almacenamiento, configuración ni red real. Todo transporte HTTP se reemplaza
por un doble de prueba, así que ninguna prueba hace solicitudes externas.

Los metadatos son fijos (hora oficial, coordenadas, precisión) para que el
sello sea determinista y verificable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.error
from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from PIL import Image, ImageDraw, ImageFont, JpegImagePlugin

from app.modules.attendance import evidence_media

API_KEY = "test-key-not-secret"
OTHER_API_KEY = "otra-clave-de-prueba"
LAT = -12.046374
LON = -77.042793
ACCURACY = 7.5
# 2026-03-15 23:30:05 UTC == 2026-03-15 18:30:05 en America/Lima (UTC-05:00).
MARKED_AT = datetime(2026, 3, 15, 23, 30, 5, tzinfo=timezone.utc)
MARKED_AT_TEXT = "15/03/2026 18:30:05 (America/Lima, UTC-05:00)"
ADDRESS = "Av. Siempre Viva 742, Miraflores, Lima"
EVIDENCE_ID = "3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"
ATTRIBUTION = "Powered by Geoapify · © OpenStreetMap contributors"


# --------------------------------------------------------------------------- #
# Dobles de transporte
# --------------------------------------------------------------------------- #


class FakeResponse:
    """Respuesta mínima compatible con el uso de ``urlopen`` en el módulo."""

    def __init__(self, body: bytes = b"", status: int = 200, headers: dict | None = None):
        self._body = body
        self.status = status
        self.headers = dict(headers or {})

    def getcode(self) -> int:
        return self.status

    def read(self, amt: int | None = None) -> bytes:
        return self._body if amt is None else self._body[:amt]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False


class FakeOpener:
    """Registra las solicitudes y nunca sale a la red."""

    def __init__(self, result: FakeResponse | None = None, error: BaseException | None = None):
        self.requests: list = []
        self.timeouts: list = []
        self._result = result
        self._error = error

    def open(self, request, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if self._error is not None:
            raise self._error
        if self._result is None:
            raise AssertionError("solicitud de red inesperada")
        return self._result

    def payloads(self) -> list[dict]:
        out = []
        for request in self.requests:
            query = dict(
                pair.split("=", 1)
                for pair in request.full_url.split("?", 1)[1].split("&")
            )
            out.append(query)
        return out


class EchoFormattedOpener(FakeOpener):
    """Devuelve una dirección distinta por coordenada (para probar la caché)."""

    def open(self, request, timeout=None):
        query = dict(
            pair.split("=", 1) for pair in request.full_url.split("?", 1)[1].split("&")
        )
        self.requests.append(request)
        self.timeouts.append(timeout)
        formatted = f"Direccion {query['lat']} {query['lon']}"
        return FakeResponse(
            json.dumps({"results": [{"formatted": formatted}]}).encode("utf-8")
        )


def json_payload(formatted: str) -> bytes:
    return json.dumps({"results": [{"formatted": formatted}]}).encode("utf-8")


class FakeClock:
    def __init__(self, value: float = 1000.0):
        self.value = value

    def __call__(self) -> float:
        return self.value


@pytest.fixture(autouse=True)
def _reset_media_state(monkeypatch):
    """Aísla caché/contadores y bloquea cualquier salida a la red."""
    evidence_media._reset_state()
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener())
    yield
    evidence_media._reset_state()


# --------------------------------------------------------------------------- #
# Imagen de origen
# --------------------------------------------------------------------------- #


def _jpeg(*, width: int = 640, height: int = 480, color=(35, 60, 95), exif_orientation: int | None = None) -> bytes:
    image = Image.new("RGB", (width, height), color)
    buffer = BytesIO()
    if exif_orientation is None:
        image.save(buffer, format="JPEG", quality=85)
    else:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        image.save(buffer, format="JPEG", quality=85, exif=exif)
    return buffer.getvalue()


PHOTO = _jpeg()


def _render(**overrides) -> bytes:
    kwargs = dict(
        employee_name="Ana Quispe",
        employee_code="OP-0042",
        event_type="CHECK_IN",
        marked_at=MARKED_AT,
        latitude=LAT,
        longitude=LON,
        accuracy_m=ACCURACY,
        address=ADDRESS,
        evidence_id=EVIDENCE_ID,
    )
    kwargs.update(overrides)
    return evidence_media.render_stamp(PHOTO, **kwargs)


def _open_stamp(raw: bytes) -> Image.Image:
    return Image.open(BytesIO(raw))


def _close(pixel, expected, tolerance: int = 16) -> bool:
    """Compara colores tolerando la compresión JPEG."""
    return all(abs(component - target) <= tolerance for component, target in zip(pixel, expected))


# --------------------------------------------------------------------------- #
# reverse_address: sin clave / coordenadas inválidas no salen a la red
# --------------------------------------------------------------------------- #


def test_sin_clave_no_hay_red_ni_resultado():
    opener = FakeOpener()
    evidence_media._OPENER = opener  # type: ignore[assignment]

    assert evidence_media.reverse_address(LAT, LON) is None
    assert evidence_media.reverse_address(LAT, LON, api_key="") is None
    assert evidence_media.reverse_address(LAT, LON, api_key="   ") is None
    assert opener.requests == []


@pytest.mark.parametrize(
    "latitude,longitude",
    [
        (91.0, 0.0),
        (-90.5, 0.0),
        (0.0, 181.0),
        (0.0, -180.5),
        (float("nan"), 0.0),
        (0.0, float("inf")),
        (float("-inf"), 0.0),
        ("-12.04", "-77.04"),
        (True, False),
        (None, 0.0),
    ],
)
def test_coordenadas_invalidas_no_consultan(latitude, longitude):
    opener = FakeOpener()
    evidence_media._OPENER = opener  # type: ignore[assignment]

    assert evidence_media.reverse_address(latitude, longitude, api_key=API_KEY) is None
    assert opener.requests == []


def test_limites_de_coordenadas_se_aceptan(monkeypatch):
    opener = FakeOpener(FakeResponse(json_payload("Polo norte")))
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    assert evidence_media.reverse_address(90.0, 180.0, api_key=API_KEY) == {
        "formatted": "Polo norte",
        "attribution": ATTRIBUTION,
    }
    assert len(opener.requests) == 1


# --------------------------------------------------------------------------- #
# reverse_address: contrato de transporte
# --------------------------------------------------------------------------- #


def test_solicitud_usa_https_host_fijo_y_solo_parametros_permitidos(monkeypatch):
    opener = FakeOpener(FakeResponse(json_payload(ADDRESS)))
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    result = evidence_media.reverse_address(LAT, LON, api_key=API_KEY)

    assert result == {"formatted": ADDRESS, "attribution": ATTRIBUTION}
    assert len(opener.requests) == 1
    url = opener.requests[0].full_url
    assert url.startswith("https://api.geoapify.com/v1/geocode/reverse?")
    query = opener.payloads()[0]
    assert set(query) == {"lat", "lon", "lang", "format", "apiKey"}
    assert query["apiKey"] == API_KEY
    assert query["lang"] == "es"
    # Coordenadas validadas y codificadas con precisión explícita.
    assert query["lat"] == "-12.046374"
    assert query["lon"] == "-77.042793"
    # Nada de nombre, DNI, foto ni token en la solicitud.
    joined = url.lower()
    for forbidden in ("dni", "employee", "worker", "photo", "foto", "token", "nombre"):
        assert forbidden not in joined
    # Tiempo de espera acotado.
    assert 0 < opener.timeouts[0] <= 10


def test_no_hay_redirecciones_a_otros_hosts():
    opener = evidence_media._build_opener()
    handlers = list(opener.handlers)
    assert any(isinstance(h, evidence_media._NoRedirectHandler) for h in handlers)
    assert not any(
        isinstance(h, urllib.request.HTTPRedirectHandler)
        and not isinstance(h, evidence_media._NoRedirectHandler)
        for h in handlers
    )
    handler = evidence_media._NoRedirectHandler()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example/x") is None


def test_redireccion_real_del_proveedor_no_produce_datos(monkeypatch):
    error = urllib.error.HTTPError(
        "https://api.geoapify.com/v1/geocode/reverse?apiKey=x",
        302,
        "Found",
        {"Location": "https://evil.example/steal"},
        None,
    )
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(error=error))

    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is None


def test_respuesta_demasiado_grande_se_descarta(monkeypatch):
    huge = b"x" * (evidence_media._MAX_RESPONSE_BYTES + 1)
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(FakeResponse(huge)))
    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is None

    declared = FakeResponse(json_payload(ADDRESS), headers={"Content-Length": str(10**7)})
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(declared))
    assert evidence_media.reverse_address(1.0, 1.0, api_key=API_KEY) is None


@pytest.mark.parametrize(
    "body",
    [
        b"no es json",
        b"[]",
        b'"texto"',
        b"{}",
        b'{"results": []}',
        b'{"results": {}}',
        b'{"results": ["texto"]}',
        b'{"results": [{"formatted": null}]}',
        b'{"results": [{"formatted": ""}]}',
    ],
)
def test_respuesta_malformada_devuelve_none(monkeypatch, body):
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(FakeResponse(body)))

    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is None


def test_respuesta_valida_se_limpia_y_se_acota(monkeypatch):
    raw = "  Av.  Lima\n\nMiraflores   " + "x" * 500
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(FakeResponse(json_payload(raw))))

    result = evidence_media.reverse_address(LAT, LON, api_key=API_KEY)

    assert result is not None
    formatted = result["formatted"]
    assert "\n" not in formatted
    assert "  " not in formatted
    assert len(formatted) <= evidence_media._MAX_FORMATTED_CHARS
    assert result["attribution"] == ATTRIBUTION
    # No se devuelven coordenadas del geocodificador: solo texto y atribución.
    assert set(result) == {"formatted", "attribution"}


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.URLError("sin salida"),
        urllib.error.HTTPError("https://api.geoapify.com/x", 401, "Unauthorized", {}, None),
        urllib.error.HTTPError("https://api.geoapify.com/x", 403, "Forbidden", {}, None),
        urllib.error.HTTPError("https://api.geoapify.com/x", 429, "Too Many Requests", {}, None),
        urllib.error.HTTPError("https://api.geoapify.com/x", 500, "Server Error", {}, None),
        TimeoutError("agotado"),
        OSError("caída de red"),
    ],
)
def test_fallos_de_proveedor_o_red_devuelven_none(monkeypatch, error):
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(error=error))

    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is None


def test_estado_http_distinto_de_200_devuelve_none(monkeypatch):
    monkeypatch.setattr(
        evidence_media, "_OPENER", FakeOpener(FakeResponse(json_payload(ADDRESS), status=204))
    )

    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is None


def test_los_logs_no_exponen_clave_ni_coordenadas(monkeypatch, caplog):
    secret = "clave-secreta-9f8e7d"
    error = urllib.error.HTTPError(
        f"https://api.geoapify.com/v1/geocode/reverse?apiKey={secret}&lat={LAT}&lon={LON}",
        429,
        "Too Many Requests",
        {},
        None,
    )
    monkeypatch.setattr(evidence_media, "_OPENER", FakeOpener(error=error))
    monkeypatch.setattr(evidence_media.logger, "disabled", False)

    with caplog.at_level(logging.WARNING, logger="app.modules.attendance.evidence_media"):
        assert evidence_media.reverse_address(LAT, LON, api_key=secret) is None

    texto = "\n".join(record.getMessage() for record in caplog.records)
    assert secret not in texto
    assert "apiKey" not in texto
    assert str(LAT) not in texto
    assert str(LON) not in texto
    assert "-12.04" not in texto
    assert texto != ""


# --------------------------------------------------------------------------- #
# reverse_address: caché, intervalo y presupuesto local
# --------------------------------------------------------------------------- #


def test_la_misma_coordenada_usa_la_cache(monkeypatch):
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    first = evidence_media.reverse_address(LAT, LON, api_key=API_KEY)
    second = evidence_media.reverse_address(LAT, LON, api_key=API_KEY)

    assert first == second
    assert len(opener.requests) == 1


def test_coordenadas_distintas_no_comparten_cache(monkeypatch):
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    first = evidence_media.reverse_address(-12.1, -77.1, api_key=API_KEY)
    second = evidence_media.reverse_address(-12.2, -77.2, api_key=API_KEY)

    assert first != second
    assert len(opener.requests) == 2


def test_la_cache_esta_acotada_y_expulsa_lo_mas_viejo(monkeypatch):
    monkeypatch.setattr(evidence_media, "_CACHE_MAX_ENTRIES", 4)
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    latitudes = [round(-12.0 - index * 0.001, 4) for index in range(6)]
    for latitude in latitudes:
        assert evidence_media.reverse_address(latitude, LON, api_key=API_KEY) is not None
    assert len(opener.requests) == 6

    # La última coordenada sigue en caché.
    evidence_media.reverse_address(latitudes[-1], LON, api_key=API_KEY)
    assert len(opener.requests) == 6

    # La primera ya fue expulsada: vuelve a consultar (caché acotada).
    evidence_media.reverse_address(latitudes[0], LON, api_key=API_KEY)
    assert len(opener.requests) == 7


def test_cache_expirada_vuelve_a_consultar(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(evidence_media, "_monotonic", clock)
    opener = FakeOpener(FakeResponse(json_payload(ADDRESS)))
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is not None
    clock.value += evidence_media._CACHE_TTL_SECONDS + 1
    assert evidence_media.reverse_address(LAT, LON, api_key=API_KEY) is not None

    assert len(opener.requests) == 2


def test_el_intervalo_minimo_espera_sin_superar_el_limite(monkeypatch):
    clock = FakeClock()
    sleeps: list[float] = []

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.value += seconds

    monkeypatch.setattr(evidence_media, "_monotonic", clock)
    monkeypatch.setattr(evidence_media, "_sleep", fake_sleep)
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    evidence_media.reverse_address(-12.1, -77.1, api_key=API_KEY)
    evidence_media.reverse_address(-12.2, -77.2, api_key=API_KEY)

    assert len(opener.requests) == 2
    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= evidence_media._MIN_REQUEST_INTERVAL_SECONDS


def test_presupuesto_local_agotado_no_consulta(monkeypatch):
    monkeypatch.setattr(evidence_media, "_MAX_REQUESTS_PER_DAY", 1)
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    assert evidence_media.reverse_address(-12.1, -77.1, api_key=API_KEY) is not None
    assert evidence_media.reverse_address(-12.2, -77.2, api_key=API_KEY) is None
    assert len(opener.requests) == 1


def test_la_clave_no_particiona_la_cache(monkeypatch):
    """La caché es por coordenada: una clave distinta no altera el resultado ya guardado."""
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    first = evidence_media.reverse_address(LAT, LON, api_key=API_KEY)
    second = evidence_media.reverse_address(LAT, LON, api_key=OTHER_API_KEY)

    assert first == second
    assert len(opener.requests) == 1


# --------------------------------------------------------------------------- #
# render_stamp: texto exacto y reglas de contenido
# --------------------------------------------------------------------------- #


def _lines(**overrides) -> list[str]:
    kwargs = dict(
        employee_name="Ana Quispe",
        employee_code="OP-0042",
        event_type="CHECK_IN",
        marked_at=MARKED_AT,
        latitude=LAT,
        longitude=LON,
        accuracy_m=ACCURACY,
        address=ADDRESS,
        evidence_id=EVIDENCE_ID,
    )
    kwargs.update(overrides)
    return evidence_media._stamp_lines(**kwargs)


def test_lineas_incluyen_codigo_interno_hora_oficial_gps_y_evidencia():
    lines = _lines()
    texto = "\n".join(lines)

    assert "Ana Quispe" in texto
    assert "Código interno: OP-0042" in texto
    assert "Entrada" in texto
    assert MARKED_AT_TEXT in texto
    assert "GPS original: -12.046374, -77.042793 (±7.5 m)" in texto
    assert f"Dirección aprox.: {ADDRESS}" in texto
    assert f"Evidencia: {EVIDENCE_ID}" in texto
    # Atribución obligatoria del proveedor y de OpenStreetMap cuando se usa la dirección.
    assert ATTRIBUTION in lines
    assert "Powered by Geoapify" in texto
    assert "OpenStreetMap" in texto


def test_no_se_imprime_dni_ni_etiquetas_de_identidad_sensible():
    texto = "\n".join(_lines())

    assert "DNI" not in texto.upper()


def test_salida_usa_etiqueta_de_salida():
    lines = _lines(event_type="CHECK_OUT")

    assert "Salida" in lines[1]


def test_tipo_de_evento_desconocido_se_muestra_limpio():
    lines = _lines(event_type="  marcacion\tmanual  ")

    assert lines[1].startswith("marcacion manual · ")


def test_hora_naive_se_interpreta_como_utc():
    naive = MARKED_AT.replace(tzinfo=None)

    assert _lines(marked_at=naive)[1] == _lines()[1]


@pytest.mark.parametrize(
    "event_type,label",
    [
        ("CHECK_IN", "Entrada"),
        ("CHECK_OUT", "Salida"),
        ("ENTRY", "Entrada"),
        ("EXIT", "Salida"),
        ("ENTRADA", "Entrada"),
        ("SALIDA", "Salida"),
        ("IN", "Entrada"),
        ("OUT", "Salida"),
        ("check_in", "Entrada"),
        (" check_out ", "Salida"),
    ],
)
def test_alias_de_evento_se_traducen_a_entrada_o_salida(event_type, label):
    assert _lines(event_type=event_type)[1].startswith(f"{label} · ")


def test_sin_direccion_no_hay_atribucion_y_usa_respaldo():
    lines = _lines(address=None)
    texto = "\n".join(lines)

    assert "Dirección aprox.: no disponible" in texto
    assert ATTRIBUTION not in lines
    assert "Powered by Geoapify" not in texto


def test_direccion_vacia_se_trata_como_ausente():
    lines = _lines(address="   ")

    assert "Dirección aprox.: no disponible" in lines
    assert ATTRIBUTION not in lines


@pytest.mark.parametrize(
    "field,value",
    [
        ("employee_name", "José Ñañez del Río " + "x" * 200),
        ("employee_code", "OP-" + "9" * 100),
        ("address", "Calle " + "Larga " * 200),
        ("evidence_id", "id-" + "a" * 200),
        ("employee_name", ""),
        ("employee_code", "   "),
        ("evidence_id", "  "),
        ("address", None),
    ],
)
def test_textos_largos_o_vacios_quedan_acotados_con_acentos(field, value):
    lines = _lines(**{field: value})
    texto = "\n".join(lines)

    assert texto.strip() != ""
    assert len(texto) <= 1200
    for line in lines:
        assert "\n" not in line
        assert "\t" not in line
    # Los acentos españoles siguen presentes tal cual (sin reemplazos raros).
    if field == "employee_name" and value.startswith("José"):
        assert "José Ñañez del Río" in texto


@pytest.mark.parametrize(
    "field,value",
    [
        ("marked_at", "2026-03-15"),
        ("marked_at", None),
        ("latitude", 120.0),
        ("longitude", "oeste"),
        ("accuracy_m", -1.0),
        ("accuracy_m", float("nan")),
        ("accuracy_m", "7.5"),
        ("evidence_id", 42),
        ("employee_name", None),
        ("address", 1234),
    ],
)
def test_metadatos_invalidos_fallan_sin_tocar_la_imagen(field, value):
    with pytest.raises(evidence_media.StampRenderError):
        _lines(**{field: value})

    with pytest.raises(evidence_media.StampRenderError):
        _render(**{field: value})


# --------------------------------------------------------------------------- #
# render_stamp: imagen resultante
# --------------------------------------------------------------------------- #


def test_salida_es_jpeg_valido_con_banda_inferior_y_sin_exif():
    salida = _render()

    assert isinstance(salida, bytes)
    assert salida != PHOTO
    assert salida[:2] == b"\xff\xd8"
    with _open_stamp(salida) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        # El lienzo se extiende hacia abajo: no se tapa la cara.
        assert image.width == 640
        assert image.height > 480
        exif = image.getexif()
        assert 34853 not in exif  # GPSInfo
        assert 36867 not in exif  # DateTimeOriginal
    Image.open(BytesIO(salida)).verify()


def test_salida_es_determinista_y_no_usa_el_reloj_del_dispositivo(monkeypatch):
    def reloj_prohibido(*args, **kwargs):
        raise AssertionError("el sello no debe leer la hora actual")

    monkeypatch.setattr(evidence_media.time, "time", reloj_prohibido)
    monkeypatch.setattr(evidence_media.time, "monotonic", reloj_prohibido)

    primera = _render()
    segunda = _render()

    assert primera == segunda


def test_la_banda_inferior_es_distinta_del_area_fotografiada():
    salida = _render()
    with _open_stamp(salida) as image:
        foto = image.crop((0, 0, 640, 480)).resize((8, 8))
        banda = image.crop((0, 500, image.width, image.height)).resize((8, 8))
        centro_foto = image.crop((200, 140, 440, 340)).resize((4, 4))

    assert list(banda.get_flattened_data() if hasattr(banda, "get_flattened_data") else banda.tobytes()) != list(
        foto.get_flattened_data() if hasattr(foto, "get_flattened_data") else foto.tobytes()
    )
    # El centro de la fotografía no se repinta: se conserva el color original.
    original = Image.open(BytesIO(PHOTO)).crop((200, 140, 440, 340)).resize((4, 4))
    for pixel, esperado in zip(centro_foto.tobytes(), original.tobytes()):
        assert abs(pixel - esperado) <= 12


def test_la_foto_original_no_se_modifica():
    original = bytes(PHOTO)
    digest = hashlib.sha256(original).hexdigest()

    evidence_media.render_stamp(original, employee_name="Ana", employee_code="OP-1",
                                event_type="CHECK_IN", marked_at=MARKED_AT,
                                latitude=LAT, longitude=LON, accuracy_m=ACCURACY,
                                address=ADDRESS, evidence_id=EVIDENCE_ID)

    assert hashlib.sha256(original).hexdigest() == digest
    assert original == PHOTO


def test_la_orientacion_exif_se_aplica_antes_de_sellar():
    girada = _jpeg(width=640, height=400, exif_orientation=6)

    salida = evidence_media.render_stamp(girada, employee_name="Ana", employee_code="OP-1",
                                         event_type="CHECK_IN", marked_at=MARKED_AT,
                                         latitude=LAT, longitude=LON, accuracy_m=ACCURACY,
                                         address=ADDRESS, evidence_id=EVIDENCE_ID)

    with _open_stamp(salida) as image:
        assert image.width < image.height  # EXIF 6: apaisado -> vertical
        assert image.width == 400


def test_el_logo_de_marca_se_incrusta_en_la_esquina_superior_derecha(monkeypatch):
    real = evidence_media._load_brand()
    assert real.getbbox() is not None  # el PNG padre no es transparente

    sin_logo = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    monkeypatch.setattr(evidence_media, "_load_brand", lambda: sin_logo)
    salida_sin_logo = _render()

    monkeypatch.undo()
    salida_con_logo = _render()

    with _open_stamp(salida_con_logo) as con, _open_stamp(salida_sin_logo) as sin:
        region_con = con.crop((con.width - 90, 0, con.width, 90))
        region_sin = sin.crop((sin.width - 90, 0, sin.width, 90))

    assert list(region_con.tobytes()) != list(region_sin.tobytes())


@pytest.mark.parametrize("background", [(8, 13, 20), (235, 230, 220)])
def test_logo_transparente_preserva_el_fondo_fuera_de_la_gota(background):
    canvas = Image.new("RGB", (720, 720), background)
    logo = evidence_media._load_brand()
    evidence_media._paste_brand(canvas, logo, 720)
    # Esquina y margen de la antigua placa: ninguna superficie clara dibujada.
    assert canvas.getpixel((625, 14)) == background
    assert canvas.getpixel((612, 8)) == background
    assert canvas.getpixel((705, 14)) == background
    assert canvas.getpixel((680, 74)) != background


def test_sin_logo_disponible_el_sello_falla_en_lugar_de_devolver_lo_mismo(monkeypatch):
    monkeypatch.setattr(evidence_media, "_BRAND_ASSET", evidence_media.Path("no-existe-drop.png"))

    with pytest.raises(evidence_media.StampRenderError):
        _render()


@pytest.mark.parametrize(
    "original",
    [
        b"",
        b"x" * 64,
        b"\xff\xd8\xff\xe0" + b"\x00" * 60,
        b"GIF89a" + b"\x00" * 64,
    ],
)
def test_origen_invalido_falla_en_lugar_de_devolverlo_tal_cual(original):
    with pytest.raises(evidence_media.StampRenderError):
        evidence_media.render_stamp(original, employee_name="Ana", employee_code="OP-1",
                                    event_type="CHECK_IN", marked_at=MARKED_AT,
                                    latitude=LAT, longitude=LON, accuracy_m=ACCURACY,
                                    address=ADDRESS, evidence_id=EVIDENCE_ID)


def test_la_salida_no_se_silencia_con_la_entrada_si_el_sello_es_valido():
    salida = _render()
    assert salida != PHOTO
    assert len(salida) > 0


def test_origen_png_se_acepta_y_sale_como_jpeg():
    buffer = BytesIO()
    Image.new("RGB", (320, 240), (90, 40, 20)).save(buffer, format="PNG")

    salida = evidence_media.render_stamp(buffer.getvalue(), employee_name="Ana",
                                         employee_code="OP-1", event_type="CHECK_IN",
                                         marked_at=MARKED_AT, latitude=LAT, longitude=LON,
                                         accuracy_m=ACCURACY, address=ADDRESS,
                                         evidence_id=EVIDENCE_ID)

    with _open_stamp(salida) as image:
        assert image.format == "JPEG"
        assert image.width == 320


def test_imagen_grande_se_acota_sin_obscurecer_la_foto():
    grande = _jpeg(width=4000, height=2000)

    salida = evidence_media.render_stamp(grande, employee_name="Ana", employee_code="OP-1",
                                         event_type="CHECK_IN", marked_at=MARKED_AT,
                                         latitude=LAT, longitude=LON, accuracy_m=ACCURACY,
                                         address=ADDRESS, evidence_id=EVIDENCE_ID)

    with _open_stamp(salida) as image:
        assert image.width == evidence_media._MAX_OUTPUT_SIDE
        assert image.height <= evidence_media._MAX_OUTPUT_SIDE + 600


def test_origen_con_pixeles_excesivos_se_rechaza(monkeypatch):
    monkeypatch.setattr(evidence_media, "_MAX_INPUT_PIXELS", 100)

    with pytest.raises(evidence_media.StampRenderError):
        _render()


def test_imagen_pequena_sigue_produciendo_sello_legible():
    pequena = _jpeg(width=320, height=240)

    salida = evidence_media.render_stamp(pequena, employee_name="Ana Quispe Rojas",
                                         employee_code="OP-0042", event_type="CHECK_OUT",
                                         marked_at=MARKED_AT, latitude=LAT, longitude=LON,
                                         accuracy_m=ACCURACY, address=ADDRESS,
                                         evidence_id=EVIDENCE_ID)

    with _open_stamp(salida) as image:
        assert image.width == 320
        assert image.height > 240
        banda = image.crop((0, 240, 320, image.height)).convert("L")
        # Hay texto dibujado (píxeles claros sobre banda oscura).
        assert len([pixel for pixel in banda.tobytes() if pixel > 120]) > 100


# --------------------------------------------------------------------------- #
# render_stamp: cada campo cambia la imagen (prueba de que se dibuja)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "field,value",
    [
        ("employee_name", "Beto Salazar"),
        ("employee_code", "OP-9999"),
        ("event_type", "CHECK_OUT"),
        ("marked_at", MARKED_AT + timedelta(seconds=1)),
        ("latitude", LAT + 0.000002),
        ("longitude", LON + 0.000002),
        ("accuracy_m", ACCURACY + 1.0),
        ("address", "Otra dirección 100, Surco"),
        ("address", None),
        ("evidence_id", "otro-id-de-evidencia"),
    ],
)
def test_cada_campo_cambia_la_imagen_sellada(field, value):
    assert _render(**{field: value}) != _render()


def test_precision_de_coordenadas_es_de_seis_decimales():
    # Diferencias por debajo del 6.º decimal no deben alterar la imagen.
    assert _render(latitude=LAT + 0.00000001) == _render()
    assert _render(longitude=LON + 0.00000001) == _render()


def test_hora_solo_cambia_con_los_segundos_no_con_la_zona_de_representacion():
    mismo_instante = MARKED_AT.astimezone(evidence_media._LIMA_TZ)

    assert _render(marked_at=mismo_instante) == _render()


# --------------------------------------------------------------------------- #
# render_stamp: fuente vectorial incluida en el proyecto y acentos españoles
# --------------------------------------------------------------------------- #


def test_los_acentos_se_conservan_al_adaptar_el_texto_a_la_fuente():
    acentuado = "Código interno: José Ñañez del Río — Av. Perú 1.º"

    adaptado = evidence_media._to_latin1(acentuado)

    # Los acentos y la eñe se conservan tal cual.
    assert "Código" in adaptado
    assert "José Ñañez del Río" in adaptado
    assert "Perú" in adaptado
    assert "1.º" in adaptado
    # Sólo se sustituye el signo tipográfico fuera de Latin-1.
    assert "—" not in adaptado
    assert "-" in adaptado


def test_caracteres_fuera_de_latin1_no_rompen_el_sello():
    adaptado = evidence_media._to_latin1("Ana 田中 García 😀")

    assert "García" in adaptado
    adaptado.encode("latin-1")  # el texto del sello siempre es dibujable


def test_los_acentos_cambian_realmente_la_imagen():
    """Si la fuente ignorara los acentos, "José" y "Jose" darían la misma imagen."""
    con_acentos = _render(employee_name="José Ñañez")
    sin_acentos = _render(employee_name="Jose Nanez")

    assert con_acentos != sin_acentos
    assert _render(employee_name="Ana García") != _render(employee_name="Ana Garcia")


def test_la_fuente_del_sello_cubre_los_acentos_usados():
    fuente = evidence_media._load_text_font()
    draw = ImageDraw.Draw(Image.new("RGB", (4, 4)))

    # La fuente incluida en el proyecto dibuja Latin-1 (no lanza y mide > 0).
    assert draw.textlength("áéíóúÁÉÍÓÚñÑüÜºª·±°", font=fuente) > 0
    assert evidence_media._to_latin1("áéíóúÁÉÍÓÚñÑüÜ") == "áéíóúÁÉÍÓÚñÑüÜ"


def test_fuente_vectorial_tiene_bordes_suaves_y_peso_real():
    regular = evidence_media._load_text_font(22)
    bold = evidence_media._load_text_font(22, bold=True)
    assert isinstance(regular, ImageFont.FreeTypeFont)
    assert bytes(regular.getmask("José Núñez")) != bytes(bold.getmask("José Núñez"))
    assert any(0 < value < 255 for value in regular.getmask("Asistencia"))
    with _open_stamp(_render()) as image:
        assert JpegImagePlugin.get_sampling(image) == 0  # 4:4:4, conserva bordes de color


def test_fuente_ausente_falla_sin_devolver_original(monkeypatch, tmp_path):
    evidence_media._load_text_font.cache_clear()
    try:
        monkeypatch.setattr(evidence_media, "_FONT_DIR", tmp_path)
        with pytest.raises(evidence_media.StampRenderError, match="fuente"):
            _render()
    finally:
        evidence_media._load_text_font.cache_clear()


@pytest.mark.parametrize("width", [320, 400, 640, 720, 1280, 2048])
def test_campos_criticos_completos_y_texto_dentro_del_lienzo(width, monkeypatch):
    """Referencia/créditos no se pierden por nombres o direcciones extensas."""
    calls = []
    real_text = ImageDraw.ImageDraw.text

    def record_text(draw, xy, text, *args, **kwargs):
        calls.append((text, draw.textbbox(xy, text, font=kwargs["font"], anchor=kwargs["anchor"])))
        return real_text(draw, xy, text, *args, **kwargs)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", record_text)
    code = "W" * 32
    reference = "e" * 64
    result = evidence_media.render_stamp(
        _jpeg(width=width, height=2048), employee_name="ÁÑ" * 30,
        employee_code=code, event_type="CHECK_IN", marked_at=MARKED_AT,
        latitude=LAT, longitude=LON, accuracy_m=ACCURACY,
        address="Dirección " + "extensa " * 45, evidence_id=reference,
    )
    text = "".join(part for part, _ in calls).replace(" ", "")
    assert code in text
    assert reference in text
    assert ATTRIBUTION.replace(" ", "") in text
    assert MARKED_AT_TEXT.replace(" ", "") in text
    assert f"{LAT:.6f},{LON:.6f}" in text
    with _open_stamp(result) as image:
        assert image.height <= evidence_media._MAX_OUTPUT_HEIGHT
        for _, (left, top, right, bottom) in calls:
            assert left >= 0 and right <= image.width
            assert top >= 2048 and bottom < image.height


def test_foto_extremadamente_estrecha_falla_sin_recortar_campos():
    with pytest.raises(evidence_media.StampRenderError, match="estrecha"):
        evidence_media.render_stamp(
            _jpeg(width=24, height=480), employee_name="Ana", employee_code="OP-1",
            event_type="CHECK_IN", marked_at=MARKED_AT, latitude=LAT, longitude=LON,
            accuracy_m=ACCURACY, address=ADDRESS, evidence_id=EVIDENCE_ID,
        )


# --------------------------------------------------------------------------- #
# Correcciones: admisión acotada ante ráfaga y tope final declarado
# --------------------------------------------------------------------------- #


def test_rafaga_simultanea_no_reserva_esperas_futuras(monkeypatch):
    """32 llegadas al mismo instante: a lo sumo una espera corta, el resto se omite.

    Con el reloj congelado (nadie avanza el tiempo), una cola de admisiones
    futuras acumularía esperas de 0.25 s, 0.5 s, ... 7.75 s. La admisión debe
    estar acotada y devolver ``None`` cuando el cupo inmediato está ocupado,
    sin reservar tiempo futuro ni consumir presupuesto.
    """
    clock = FakeClock(1000.0)  # reloj congelado: sólo avanza cuando la prueba lo mueve
    sleeps: list[float] = []
    monkeypatch.setattr(evidence_media, "_monotonic", clock)
    monkeypatch.setattr(evidence_media, "_sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(evidence_media, "_MAX_REQUESTS_PER_DAY", 3)
    opener = EchoFormattedOpener()
    monkeypatch.setattr(evidence_media, "_OPENER", opener)

    resultados = [
        evidence_media.reverse_address(round(-12.0 - index * 0.001, 4), LON, api_key=API_KEY)
        for index in range(32)
    ]

    # La primera sale; la segunda admite una espera corta; el resto se omite.
    assert resultados[0] is not None
    assert resultados[1] is not None
    assert all(resultado is None for resultado in resultados[2:])
    assert len(opener.requests) == 2
    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= 0.25
    # Las 30 admisiones omitidas no reservan turnos futuros ni gastan presupuesto:
    # al avanzar el reloj vuelve a admitirse una consulta nueva.
    clock.value += 1.0
    assert evidence_media.reverse_address(-12.5, LON, api_key=API_KEY) is not None
    assert len(opener.requests) == 3


def test_la_salida_respeta_el_tope_final_declarado():
    """Caso reportado: 640x2048 (vertical) no puede exceder el tope documentado."""
    alta = _jpeg(width=640, height=2048)

    salida = evidence_media.render_stamp(alta, employee_name="Ana Quispe Rojas",
                                         employee_code="OP-0042", event_type="CHECK_IN",
                                         marked_at=MARKED_AT, latitude=LAT, longitude=LON,
                                         accuracy_m=ACCURACY, address=ADDRESS,
                                         evidence_id=EVIDENCE_ID)

    with _open_stamp(salida) as image:
        assert image.width <= evidence_media._MAX_OUTPUT_SIDE
        # Tope final declarado = fotografía acotada + banda máxima calculada.
        banda_maxima = 597
        assert evidence_media._MAX_BAND_HEIGHT == banda_maxima
        assert evidence_media._MAX_OUTPUT_HEIGHT == evidence_media._MAX_OUTPUT_SIDE + banda_maxima
        assert image.height <= evidence_media._MAX_OUTPUT_HEIGHT
        # La banda se añadió completa (no recortada): acento en su primera fila
        # y relleno de fondo en la última.
        assert image.height > 2048
        assert _close(image.getpixel((2, 2048)), evidence_media._ACCENT, tolerance=32)
        assert _close(image.getpixel((2, image.height - 1)), evidence_media._FOOTER_BG)


def test_atribucion_completa_sobrevive_foto_rotada_y_metadatos_largos(monkeypatch, tmp_path):
    """La composición final conserva créditos y datos dentro del tope físico."""
    drawn = []
    real_text = ImageDraw.ImageDraw.text

    def capture_text(self, xy, text, *args, **kwargs):
        drawn.append((text, self.textbbox(xy, text, font=kwargs.get("font"), anchor=kwargs.get("anchor"))))
        return real_text(self, xy, text, *args, **kwargs)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", capture_text)
    original = _jpeg(width=320, height=240, exif_orientation=6)
    original_hash = hashlib.sha256(original).hexdigest()
    result = evidence_media.render_stamp(
        original,
        employee_name="María Fernanda del Carmen Rodríguez de la Cruz Sánchez",
        employee_code="EMP-001",
        event_type="CHECK_IN",
        marked_at=MARKED_AT,
        latitude=LAT,
        longitude=LON,
        accuracy_m=12.5,
        address=(
            "Avenida Los Próceres de la Independencia, urbanización "
            "Las Flores, distrito de San Juan de Lurigancho, Lima, Perú. "
        ) * 3,
        evidence_id=EVIDENCE_ID,
    )
    (tmp_path / "stamped-long.jpg").write_bytes(result)
    assert hashlib.sha256(original).hexdigest() == original_hash
    text = "".join(line for line, _box in drawn).replace(" ", "")
    with _open_stamp(result) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        assert image.width == 240  # EXIF 6, sin recortar la fotografía.
        assert 320 < image.height <= 2645
        assert image.height - 320 <= 597
        assert not image.getexif().get(0x0112)
        assert ATTRIBUTION.replace(" ", "") in text
        assert "EMP-001" in text
        assert MARKED_AT_TEXT.replace(" ", "") in text
        assert f"{LAT:.6f},{LON:.6f}(±12.5m)" in text
        assert EVIDENCE_ID.replace(" ", "") in text
        for line, (left, top, right, bottom) in drawn:
            assert 0 <= left < right <= image.width, line
            assert 320 <= top < bottom <= image.height, line
            if any(word in line for word in ("Powered", "Geoapify", "OpenStreetMap", "contributors")):
                region = image.crop((left, top, right, bottom))
                assert any(
                    min(region.getpixel((x, y))) > 150
                    for y in range(region.height)
                    for x in range(region.width)
                ), line
