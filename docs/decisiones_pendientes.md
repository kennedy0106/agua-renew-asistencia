# Decisiones pendientes (no implementadas)

Este documento lista reglas de negocio que el producto aún no fija.
No se inventan en código hasta que haya una decisión explícita.

## Prorrateo salarial

Hoy el cálculo usa `sueldo / 30 / minutos de jornada` para el valor minuto.
Queda pendiente confirmar si el denominador debe ser 30 o los días reales
del mes (febrero, meses de 31 días, alta o cese a mitad de periodo).

## Refrigerio en jornada partida

El refrigerio se descuenta una sola vez del consolidado diario cuando se
alcanza el umbral. Falta validar esa semántica con el régimen laboral
aplicable (si el refrigerio es tiempo no laborado, si se fracciona, y qué
ocurre con más de dos sesiones).

## Feriados y nocturnidad

No hay recargo por feriado ni por hora nocturna. Cualquier recargo futuro
debe ser una regla explícita, no un ajuste manual silencioso.

## Retención y tratamiento de las fotos de marcación

Las fotos se guardan como JPEG privado, sin metadatos, ligadas al evento.
La limpieza actual borra evidencias abandonadas (nonce nunca confirmado)
tras 24 horas. La retención definitiva, el aviso de tratamiento y el
derecho de supresión de fotos confirmadas quedan pendientes.

## Mínimos de resolución de evidencia

Valores propuestos, no validados como política laboral:

- mínimo 320×240
- máximo 4000×4000
- máximo 2 MiB de entrada
- salida JPEG, lado mayor 1280, calidad 80

Si se rechazan, hay que cambiar `app/core/images.py` y este documento juntos.
