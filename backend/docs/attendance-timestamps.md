# Horas de marcación en respuestas JSON

`AttendanceRecordOut` devuelve `check_in_at` y `check_out_at` con zona UTC explícita.
Una fecha sin zona recuperada de SQLite se interpreta como UTC; una fecha con
otro offset se convierte conservando el mismo instante.

La normalización se aplica solo al serializar JSON: no modifica los valores
Python, los datos almacenados ni `created_at`/`updated_at`.

`check_in_at` sigue siendo obligatorio y no nulo. `check_out_at` sigue siendo
obligatorio y admite `null` mientras la jornada permanece abierta. El contrato
OpenAPI conserva esas condiciones.
