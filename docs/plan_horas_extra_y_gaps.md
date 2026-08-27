# Plan — Huecos de edición + Rediseño de Horas Extra (seccion_horas_extra.md)

> Estado: **CONFIRMADA** — decisiones de negocio tomadas (ver abajo). Ejecución en curso: A1+A2 primero, luego rediseño HE.
> Fuentes: `seccion_horas_extra.md` (spec de horas extra) + auditoría de gaps previa.

## Decisiones de negocio (confirmadas por el usuario)

1. **Métodos**: reemplazar todo por **tramos** (quitar FIXED_RATE y MANUAL).
2. **Valor hora**: mantener derivación real (`sueldo / minutos esperados del mes`), NO `/30/8`.
3. **Alcance**: hacer ya A1+A2; el rediseño de HE después.

---

## Parte A — Huecos detectados (arreglos inmediatos)

| # | Hueco | Fix |
|---|---|---|
| A1 | Mensaje 409 confuso al editar sueldo/jornada (no dice que la fecha debe ser posterior a la vigente) | Mensaje claro + pre-llenar "Vigente desde" con el día siguiente a la vigencia actual |
| A2 | Cambios de sueldo/jornada NO se auditan (a diferencia de correcciones de asistencia) | Añadir `AuditRepository.create()` en `SalaryService.set_salary` y `ScheduleService.set_schedule` |
| A3 | Empleado sin jornada → `expected_minutes = 0` → cualquier marcación genera "horas extra" falsas | Guard en la UI + aviso claro; el cálculo ya lo prevé (fallback 240h en tarifa) |
| A4 | Empleado inactivo conserva jornada/sueldo "vigente" | Al desactivar, cerrar la vigencia activa (no borrar, solo cerrar `effective_to`) |

**A1 y A2 son los que responden tu pregunta y son de bajo riesgo.** A3/A4 son de higiene.

---

## Parte B — Acoplamiento de `seccion_horas_extra.md`

### B.0 Lo que cambia (modelo mental)

La spec reemplaza el modelo actual de horas extra — un **único `overtime_percentage` libre** — por **dos tramos legales por día**:

```
Primeras 2 horas extra del día  → mínimo 25% de recargo
Tercera hora en adelante         → mínimo 35% de recargo
```

con tres capas de decisión (§18):

```
MÍNIMO LEGAL (25/35) + POLÍTICA GENERAL DE EMPRESA + EXCEPCIÓN OPCIONAL POR EMPLEADO
```

### B.1 Modelo de datos nuevo

1. **`company_overtime_policy`** (nueva tabla, vigencia histórica):
   - `first_two_hours_rate` Decimal (≥25)
   - `additional_hours_rate` Decimal (≥35)
   - `effective_from` / `effective_to`
   - `reason` (motivo del cambio, para auditoría)

2. **`salary_settings`** (nuevos campos, excepción por empleado):
   - `use_custom_overtime_rates` bool (default false)
   - `custom_first_two_hours_rate` Decimal nullable (≥25)
   - `custom_additional_hours_rate` Decimal nullable (≥35)

3. **`CHECK` constraints en PostgreSQL** (mínimos a nivel BD, §14):
   ```sql
   CHECK (first_two_hours_rate >= 25)
   CHECK (additional_hours_rate >= 35)
   ```

### B.2 Lógica central (backend, sin duplicar)

```python
get_effective_overtime_rates(employee_id, date) -> {
    "first_two_hours_rate": 50,
    "additional_hours_rate": 60,
    "source": "company_policy" | "employee_override"
}
```
- Resuelve: si el empleado tiene override vigente → lo usa; si no → política general vigente.
- **Todo el payroll y el cálculo de HE usan esta función** (§7). Nunca se decide en dos sitios.

### B.3 Cálculo por tramos (diario, contador se reinicia cada día §9)

Por cada día con sobretiempo aprobado:
- minutos 0–120 → `first_two_hours_rate`
- minutos 120+ → `additional_hours_rate`
- valor hora ordinaria = `sueldo_mensual / minutos_esperados_del_mes` (ya existe en `OvertimeService.hourly_rate`)

Ejemplo de la spec (S/1500, jornada 8h, 3h extra, override 50/75):
```
valor hora = 1500/30/8 = 6.25
hora 1 → 6.25 × 1.50 = 9.375
hora 2 → 6.25 × 1.50 = 9.375
hora 3 → 6.25 × 1.75 = 10.9375
total = 29.6875 → S/ 29.69 (redondeo)
```

### B.4 Rutas y permisos (§17)

- `GET/POST /api/v1/overtime-policy` → **ADMIN/BOSS** (política general)
- `GET /api/v1/overtime-policy/effective?employee_id=&date=` → devuelve tasas efectivas (ADMIN/BOSS)
- Config de excepción por empleado → dentro de `salary-settings` (ADMIN/BOSS)
- SUPERVISOR: solo consulta de horas trabajadas, **sin** montos ni tarifas.

### B.5 Validaciones (§12, §13)

- Frontend (mensajes) + **obligatoriamente FastAPI** (422 si `first < 25` o `additional < 35`).
- El frontend nunca es la única capa de validación.

### B.6 Auditoría (§16)

Toda modificación de política → `audit_logs` con acción `UPDATE_OVERTIME_POLICY`, old/new, `performed_by` y `reason`.

---

## Parte C — Orden de implementación propuesto

1. **A1 + A2** (mensaje 409 + auditoría de sueldo/jornada) — bajo riesgo, responde tu pregunta directa.
2. **B.1–B.5** (rediseño HE por tramos) — migración + servicio + router + tests.
3. **B.6** (auditoría de política HE).
4. Frontend: sección de política general + excepción por empleado en el detalle.
5. Tests (TDD): validaciones de mínimos, tramos diarios, override, auditoría.

---

## ⚠️ Decisiones de negocio que necesito confirmar ANTES de ejecutar

1. **¿Qué pasa con los métodos `FIXED_RATE` (tarifa fija S/hora) y `MANUAL` (monto en periodo) que ya existen?**
   La spec solo habla de **porcentajes por tramos**. No menciona tarifa fija ni monto manual. Opciones:
   - (a) Reemplazar todo por tramos (eliminar FIXED_RATE/MANUAL) — fiel a la spec, pero pierde funcionalidad ya probada.
   - (b) Mantener FIXED_RATE/MANUAL como métodos alternativos y añadir los tramos como el método principal por defecto.
   - (c) Solo añadir tramos cuando el método sea PERCENTAGE.

2. **¿El redondeo de la tarifa y montos?**
   La spec dice "según la política de redondeo establecida". Hoy usamos `ROUND_HALF_UP` a 2 decimales para montos y 4 decimales para la tarifa/hora. ¿Confirmas ese redondeo, o hay una regla interna de Agua ReNew?

3. **Valor hora del ejemplo**: la spec usa `1500/30/8 = 6.25` (división por 30 días fijos). Hoy derivamos la tarifa con `sueldo / minutos_esperados_del_mes` (jornada real). ¿Mantengo la derivación real (más precisa, respeta jornadas variables) o cambio a la fórmula de 30×8 de la spec?
