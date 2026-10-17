# Evidencia fotográfica y dirección aproximada (helpers puros)

Este documento describe el comportamiento del módulo puro
`app.modules.attendance.evidence_media`. No autoriza producción, despliegues,
proveedores reales ni cambios de esquema. El módulo **no** toca base de datos,
almacenamiento, roles, configuración ni relojes del sistema: recibe metadatos
ya resueltos por el servicio de asistencia y devuelve valores acotados.

Exporta dos funciones y un error de dominio:

| Símbolo | Rol |
| --- | --- |
| `reverse_address(latitude, longitude, *, api_key="") -> dict \| None` | Dirección aproximada opcional |
| `render_stamp(original: bytes, *, ...) -> bytes` | JPEG sellado a partir de la foto original |
| `StampRenderError` | Falla controlada del sello (nunca se devuelve el original "como si" estuviera sellado) |

## `reverse_address`

Devuelve `{"formatted": str, "attribution": str}` con textos acotados, o
`None`. Nunca devuelve las coordenadas del geocodificador y nunca modifica las
coordenadas originales del llamador: el punto GPS guardado es el del
dispositivo, no el del edificio más cercano.

### Sin clave no hay red

Sin `api_key` (ausente, vacía o sólo espacios) la función devuelve `None` sin
consultar caché ni red. La ausencia de clave es un caso normal, no un error.

### Transporte

- Sólo biblioteca estándar (`urllib`); no se agregaron dependencias.
- Host fijo `https://api.geoapify.com/v1/geocode/reverse`, HTTPS únicamente.
- Parámetros enviados: `lat`, `lon` (6 decimales), `lang=es`, `format=json`,
  `apiKey`. No se envían nombre, DNI, foto, token ni identificadores del
  trabajador.
- Tiempo de espera acotado (4 s) y respuesta acotada (16 KiB declarados o
  leídos). Una respuesta mayor se descarta.
- **Sin redirecciones**: el abridor instala un manejador que rechaza cualquier
  `3xx`, de modo que la clave nunca viaja a otro host.
- Coordenadas validadas antes de construir la URL: números finitos, latitud en
  `[-90, 90]`, longitud en `[-180, 180]`. Valores no numéricos, `bool`, `NaN`,
  `inf` o fuera de rango devuelven `None` sin red.
- Respuestas malformadas (no JSON, sin `results`, `formatted` no textual o
  vacío) devuelven `None`.
- Cuota agotada, `401/403/429/5xx`, `URLError`, `TimeoutError` y `OSError`
  devuelven `None`: la dirección es un enriquecimiento y su ausencia nunca debe
  perder una marcación válida.
- Los registros de log incluyen únicamente el **tipo** de excepción: nunca la
  URL, la clave, las coordenadas ni el cuerpo de la respuesta.

### Caché y tasas locales al proceso

Valores por defecto: precisión de caché 4 decimales (~11 m), TTL 600 s, 256
entradas con expulsión de la más antigua, intervalo mínimo 0.25 s entre
consultas (≈4 req/s) y presupuesto local de 2500 consultas por ventana de 24 h.
La caché guarda sólo el texto de la dirección (nunca la clave) y es segura para
hilos.

**Estos contadores y la caché son locales al proceso, no una cuota de cuenta.**
Varios workers o instancias no comparten presupuesto ni caché, así que no
protegen la cuota del proveedor a nivel de cuenta. El plan gratuito de Geoapify
(3000 créditos/día, 1 crédito por consulta inversa, hasta 5 req/s) no queda
"protegido" por estas salvaguardas: la verificación de cuota y configuración de
cuenta es un chequeo previo a publicación, fuera de este módulo.

La admisión también está acotada: si ya hay una consulta en curso, una llegada
simultánea espera como máximo un intervalo (0.25 s) y las siguientes se omiten
devolviendo `None`, **sin** reservar turnos futuros ni consumir presupuesto. Una
ráfaga de 32 llegadas al mismo instante no acumula esperas crecientes: hace una
consulta, admite una espera corta y omite el resto, de modo que una dirección
opcional nunca bloquea la ruta de marcación durante segundos.

### Respaldo cuando no hay dirección

Sin clave, cuota, red o respuesta utilizable, el panel muestra la ubicación como
no disponible y el enlace a Google Maps usa únicamente las coordenadas
originales guardadas. No se inventan direcciones ni puntos retroactivos.

## `render_stamp`

```python
render_stamp(
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
) -> bytes
```

### Metadatos impresos (texto exacto)

1. `{nombre} · Código interno: {código}`
2. `{Entrada|Salida} · dd/mm/aaaa HH:MM:SS (America/Lima, UTC-05:00)`
3. `GPS original: -12.046374, -77.042793 (±7.5 m)`
4. `Dirección aprox.: {dirección}` o `Dirección aprox.: no disponible`
5. `Evidencia: {evidence_id}`
6. `Powered by Geoapify · © OpenStreetMap contributors` — **sólo** cuando se usó
   la dirección aproximada.

- La hora oficial es el argumento `marked_at` (naive se interpreta como UTC),
  presentada en Peru con segundos y zona. Nunca se usa el reloj del
  dispositivo, de la subida ni de la base de datos, y reintentos con los mismos
  metadatos producen exactamente los mismos bytes.
- Se imprime el **código interno** del trabajador; no hay campo ni etiqueta de
  DNI.
- `event_type` se traduce a `Entrada`/`Salida` (acepta `CHECK_IN`,
  `CHECK_OUT`, `ENTRY`, `EXIT`, `ENTRADA`, `SALIDA`, `IN`, `OUT`); un valor
  desconocido se muestra limpio y acotado.
- Los textos se limpian (sin caracteres de control ni saltos), se acotan por
  campo y la dirección se envuelve y se trunca con puntos suspensivos.

### Diseño de la imagen

- La gota de marca (`backend/app/assets/brand/agua-renew-drop.png`, propiedad
  del repositorio; este módulo no la modifica) se pega en la **esquina superior
  derecha** sobre una placa clara redondeada, para que sea legible sobre fotos
  oscuras o claras.
- Los metadatos van en una **banda inferior que extiende el lienzo**: no se
  tapa ninguna parte de la fotografía, en particular el rostro. El ancho del
  resultado no cambia; el alto aumenta lo que ocupe la banda.
- El texto usa la fuente bitmap incluida en Pillow
  (`ImageFont.load_default_imagefont`), que cubre ISO-8859-1 y por lo tanto
  dibuja correctamente `á é í ó ú ñ ü Á É Í Ó Ú Ñ Ü º ª ± ° ·`. Se amplía por un
  factor entero (vecino más cercano) para mantener la legibilidad. No se usan
  fuentes del sistema, archivos externos ni conversores.
  - Motivo: la fuente vectorial que devuelve `ImageFont.load_default(size=...)`
    (Aileron) **no** incluye vocales acentuadas ni la eñe y las dibujaría como
    cajas vacías. Requiere Pillow ≥ 10.1; `pyproject.toml` ya exige ≥ 11.
- Caracteres fuera de Latin-1 se sustituyen por equivalentes legibles (`…` →
  `...`, `—` → `-`, comillas tipográficas) o se transliteran; un carácter no
  dibujable nunca rompe el sello.

### Límites y determinismo

- Entrada: bytes de 32 B a 2 MiB, formatos JPEG/PNG/WebP, hasta 16 millones de
  píxeles. La orientación EXIF se aplica antes de sellar.
- Salida: JPEG en modo RGB, sin metadatos EXIF (sin GPS ni fecha de captura).
  El lado mayor de la **fotografía** se acota a `_MAX_OUTPUT_SIDE` (2048 px; las
  fuentes más grandes se reducen). La banda inferior se **suma** a ese alto y
  está acotada a **597 px**: el presupuesto equivale a 12 líneas a escala
  máxima; a escalas menores admite más filas dentro del mismo límite físico,
  conservando la referencia y los créditos con metadatos largos y fotos rotadas.
  `_MAX_BAND_HEIGHT` = (2·8 + 3 + 12·15)·3 = 597 px. Por eso el tope final
  declarado es `_MAX_OUTPUT_HEIGHT` = 2048 + 597 = **2645 px de alto** (ancho
  ≤ 2048). Una fuente vertical de 640x2048, por ejemplo, sale 640x2157: dentro
  del tope declarado. La banda y el logo nunca se recortan.
- Los bytes de `original` nunca se modifican y el resultado es determinista
  para los mismos metadatos.
- Entrada inválida, metadatos inválidos o logo ausente lanzan
  `StampRenderError`; nunca se devuelve la fotografía original como si
  estuviera sellada.
- El módulo no lee ni escribe almacenamiento, base de datos ni roles: el
  llamador decide si persiste el derivado privado.

## Pruebas

Pruebas puras en `backend/tests/test_evidence_media.py`; **todo** el transporte
HTTP se reemplaza por un doble, así que no hay solicitudes externas. Desde la
raíz del repositorio, con el intérprete del venv existente:

```bash
PYTHONPATH=backend PYTHONDONTWRITEBYTECODE=1 \
  backend/.venv/Scripts/python.exe -m pytest \
  backend/tests/test_evidence_media.py --noconftest -q -p no:cacheprovider
```

`--noconftest` evita los fixtures de base de datos/S3, que no aplican a un
módulo puro; el archivo también pasa dentro de la suite completa.

Cobertura relevante: sin clave y coordenadas inválidas no consultan; host fijo,
parámetros permitidos, sin redirecciones, límites de respuesta, errores de
proveedor/red, privacidad de logs, caché/intervalo/presupuesto, ráfaga con
admisión acotada (una espera corta y el resto omitido sin reservar tiempo ni
presupuesto); líneas exactas del sello, ausencia de DNI, acentos legibles,
determinismo sin reloj, inmutabilidad del original, orientación EXIF, logo
incrustado, tope final declarado (fotografía + banda, sin recortes) y fallas
controladas.

## Limitaciones explícitas

- Las coordenadas son **reportadas por el cliente**; ni la precisión ni el sello
  son prueba anti-suplantación ni certifican la ubicación física.
- La dirección aproximada es un enriquecimiento de proveedor: puede faltar,
  estar desactualizada o ser imprecisa. No es prueba de ubicación.
- No hay verificación con proveedor real, teléfono físico ni credenciales; esas
  pruebas no son reemplazables por dobles y quedan fuera de este alcance.
- Los límites de caché/tasas son locales al proceso y no representan la cuota
  de la cuenta del proveedor.
