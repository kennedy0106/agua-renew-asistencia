# Agua ReNew — Plan de Desarrollo por Fases y Módulos
## MVP de Asistencia y Cálculo Interno de Remuneraciones

---

# 1. Objetivo de este documento

Este documento define **cómo debe ejecutarse el desarrollo** del MVP de asistencia de Agua ReNew.

No describe únicamente qué funciones debe tener el sistema, sino **en qué orden deben construirse**, qué módulos dependen de otros, qué debe probarse antes de continuar y qué resultado debe quedar al final de cada fase.

El objetivo es evitar:

- desarrollar demasiadas funciones al mismo tiempo;
- mezclar lógica de asistencia con lógica salarial;
- crear pantallas antes de que el backend esté estable;
- duplicar cálculos entre frontend y backend;
- rehacer módulos cuando el sistema crezca;
- construir accidentalmente un ERP completo antes de terminar el MVP.

La estrategia recomendada es:

```text
Base técnica
    ↓
Autenticación
    ↓
Empleados
    ↓
Jornadas
    ↓
Asistencia
    ↓
Ajustes y recuperación
    ↓
Horas extra
    ↓
Cálculo salarial
    ↓
Auditoría / exportación
    ↓
Deploy y estabilización
```

---

# 2. Stack de referencia

El desarrollo debe conservar el stack ya definido.

## Frontend

```text
Next.js
TypeScript
React
Tailwind CSS
```

Hosting:

```text
Vercel
```

---

## Backend

```text
Python
FastAPI
Pydantic
SQLAlchemy 2.x
Alembic
pytest
```

Hosting:

```text
Railway
```

---

## Base de datos

```text
PostgreSQL
```

Servicio:

```text
Neon
```

---

# 3. Principio de desarrollo

Cada fase debe terminar con:

1. funcionalidad implementada;
2. migraciones funcionando;
3. tests mínimos aprobados;
4. endpoints comprobados;
5. frontend conectado cuando corresponda;
6. documentación actualizada;
7. commit estable.

No avanzar a la siguiente fase si existen errores estructurales en la anterior.

---

# 4. Estrategia general de ramas y commits

Se recomienda trabajar sobre ramas pequeñas.

Ejemplo:

```text
main
│
├── feat/project-bootstrap
├── feat/auth
├── feat/employees
├── feat/work-schedules
├── feat/attendance
├── feat/hour-adjustments
├── feat/overtime
├── feat/payroll
└── feat/audit-export
```

Cada fase debe terminar con merge a:

```text
main
```

únicamente después de pasar tests.

---

# 5. FASE 0 — Preparación y definición del proyecto

## Objetivo

Dejar lista la estructura base antes de implementar lógica de negocio.

---

## Tareas

### 5.1 Crear estructura del repositorio

```text
agua-renew-erp/
│
├── frontend/
├── backend/
├── docs/
├── .gitignore
└── README.md
```

---

### 5.2 Backend mínimo

Crear:

```text
backend/app/main.py
```

Endpoint:

```text
GET /health
```

Respuesta:

```json
{
  "status": "ok"
}
```

---

### 5.3 Frontend mínimo

Crear proyecto Next.js.

Pantalla inicial temporal:

```text
Agua ReNew
Sistema de Asistencia
```

---

### 5.4 Variables de entorno

Backend:

```text
DATABASE_URL
SECRET_KEY
ENVIRONMENT
FRONTEND_URL
TIMEZONE=America/Lima
```

Frontend:

```text
NEXT_PUBLIC_API_URL
```

---

### 5.5 Base de datos

Crear proyecto Neon.

Verificar conexión desde local.

---

### 5.6 Alembic

Inicializar migraciones.

No utilizar `create_all()` como mecanismo principal de producción.

---

## Entregable de Fase 0

Debe existir:

```text
Frontend funcionando localmente
Backend funcionando localmente
FastAPI conectado a Neon
Alembic configurado
Health check funcionando
```

---

## Criterio de salida

No avanzar hasta comprobar:

```text
GET /health → 200 OK
```

y conexión real a PostgreSQL.

---

# 6. FASE 1 — Núcleo de seguridad y autenticación

## Objetivo

Construir el acceso administrativo antes de crear funciones sensibles.

---

## Módulos

```text
auth
users
system_roles
```

---

## 6.1 Crear system_roles

Roles iniciales:

```text
ADMIN
BOSS
SUPERVISOR
```

---

## 6.2 Crear users

Campos mínimos:

```text
id
username
password_hash
employee_id nullable
system_role_id
active
last_login_at
created_at
updated_at
```

---

## 6.3 Seed de roles

Crear seed idempotente.

Debe poder ejecutarse más de una vez sin duplicar registros.

---

## 6.4 Primer administrador

Crear mecanismo seguro para generar el primer ADMIN.

No guardar una contraseña fija en el repositorio.

---

## 6.5 Login

Endpoint:

```text
POST /api/v1/auth/login
```

---

## 6.6 Sesión

Implementar cookie segura o JWT en cookie.

Características:

```text
HttpOnly
Secure en producción
SameSite
```

---

## 6.7 Endpoint de sesión actual

```text
GET /api/v1/auth/me
```

---

## 6.8 Logout

```text
POST /api/v1/auth/logout
```

---

## 6.9 Middleware / dependencias de permisos

Crear utilidades reutilizables.

Ejemplo conceptual:

```python
require_role("ADMIN")
require_any_role("ADMIN", "BOSS")
```

---

## Frontend de esta fase

Crear:

```text
/admin/login
/admin/dashboard
```

Dashboard puede ser todavía vacío.

---

## Tests obligatorios

- login correcto;
- contraseña incorrecta;
- usuario inactivo;
- acceso sin autenticación;
- acceso con rol correcto;
- acceso con rol incorrecto;
- logout.

---

## Entregable de Fase 1

Debe existir un panel protegido al que solo acceden usuarios autenticados.

---

# 7. FASE 2 — Cargos laborales

## Objetivo

Separar cargos laborales de permisos del sistema.

---

## Módulo

```text
job_roles
```

---

## Modelo

```text
id
name
description
active
created_at
updated_at
```

---

## Endpoints

```text
GET   /api/v1/job-roles
POST  /api/v1/job-roles
PATCH /api/v1/job-roles/{id}
```

---

## Frontend

Ruta:

```text
/admin/roles
```

Funciones:

- listar;
- crear;
- editar;
- desactivar.

---

## Validaciones

- nombre obligatorio;
- evitar duplicados activos;
- no borrar cargos usados por empleados;
- desactivar en lugar de eliminar.

---

## Entregable

Los jefes/admin pueden crear cargos como:

```text
Operario
Chofer
Almacén
Ventas
Administrativo
```

---

# 8. FASE 3 — Gestión de empleados

## Objetivo

Construir la entidad central que luego utilizarán asistencia y ERP.

---

## Módulo

```text
employees
```

---

## Modelo

```text
id
dni
employee_code
first_name
last_name
job_role_id
hire_date
termination_date
active
created_at
updated_at
```

---

## Reglas

- DNI único.
- employee_code único.
- empleado no se elimina si tiene historial.
- cesado = inactivo.
- cargo laboral obligatorio o nullable según decisión de negocio.
- validar DNI en formato esperado.

---

## Endpoints

```text
GET    /api/v1/employees
POST   /api/v1/employees
GET    /api/v1/employees/{id}
PATCH  /api/v1/employees/{id}
POST   /api/v1/employees/{id}/deactivate
```

---

## Frontend

### Listado

```text
/admin/employees
```

Columnas:

```text
Nombre
DNI
Código
Cargo
Estado
Acciones
```

---

### Nuevo empleado

```text
/admin/employees/new
```

---

### Detalle

```text
/admin/employees/{id}
```

---

## Tests

- crear empleado;
- DNI duplicado;
- código duplicado;
- editar;
- desactivar;
- usuario sin permisos;
- listado filtrado.

---

## Entregable de Fase 3

Debe ser posible administrar empleados sin tener todavía asistencia.

---

# 9. FASE 4 — Jornadas laborales

## Objetivo

Definir cuánto debe trabajar cada empleado.

---

## Módulo

```text
schedules
```

---

## Modelo recomendado

```text
work_schedules
```

Campos:

```text
id
employee_id
monday_minutes
tuesday_minutes
wednesday_minutes
thursday_minutes
friday_minutes
saturday_minutes
sunday_minutes
break_minutes
effective_from
effective_to
created_at
updated_at
```

---

## Regla importante

No sobrescribir historial.

Si cambia la jornada:

```text
Jornada anterior
effective_to = fecha anterior al cambio
```

Crear nueva:

```text
effective_from = nueva fecha
```

---

## Frontend

En detalle del empleado:

```text
Jornada laboral
```

Permitir:

```text
Lunes      8 h
Martes     8 h
...
```

Frontend puede capturar horas/minutos.

Backend debe guardar minutos.

---

## Servicio requerido

Crear:

```text
ScheduleService
```

Debe responder:

```text
expected_minutes(employee_id, date)
```

---

## Tests

- jornada lunes;
- día no laborable;
- cambio de jornada por fecha;
- break;
- empleado sin jornada.

---

## Entregable

El backend puede determinar:

```text
¿Cuántos minutos debía trabajar Juan el 25/08/2026?
```

---

# 10. FASE 5 — Configuración salarial

## Objetivo

Registrar sueldo mensual y reglas de horas extra sin calcular todavía la nómina completa.

---

## Módulo

```text
salary
```

---

## Modelo

```text
salary_settings
```

Campos:

```text
id
employee_id
monthly_salary
overtime_enabled
overtime_method
overtime_percentage
overtime_fixed_rate
effective_from
effective_to
created_at
updated_at
```

---

## Métodos de horas extra

```text
PERCENTAGE
FIXED_RATE
MANUAL
```

---

## Regla

No sobrescribir sueldo histórico.

Ejemplo:

```text
S/1300 → S/1500
```

Debe quedar como dos configuraciones con vigencias distintas.

---

## Permisos

Solo:

```text
ADMIN
BOSS
```

pueden consultar esta información.

SUPERVISOR no puede acceder.

---

## Tests

- guardar sueldo;
- cambiar sueldo;
- vigencia correcta;
- supervisor bloqueado;
- valor Decimal;
- método de hora extra válido.

---

# 11. FASE 6 — Marcación de asistencia

## Objetivo

Construir la función principal visible para trabajadores.

---

## Módulo

```text
attendance
```

---

## Modelo

```text
attendance_records
```

Campos:

```text
id
employee_id
work_date
check_in_at
check_out_at
worked_minutes
status
notes
created_at
updated_at
```

---

## Flujo público

```text
DNI / código
    ↓
Identificar
    ↓
Empleado válido
    ↓
Ver estado actual
    ↓
Entrada o salida
```

---

## Endpoints

```text
POST /api/v1/attendance/identify
POST /api/v1/attendance/check-in
POST /api/v1/attendance/check-out
```

---

## Validaciones

### Check-in

Rechazar si:

- empleado no existe;
- empleado está inactivo;
- ya tiene una entrada abierta.

---

### Check-out

Rechazar si:

- no existe entrada abierta;
- empleado está inactivo según política decidida;
- la salida produce una inconsistencia grave.

---

## Tiempo

La hora debe provenir del backend.

No usar timestamp enviado por navegador como fuente oficial.

---

## Frontend público

Ruta:

```text
/
```

o:

```text
/asistencia
```

Debe ser muy simple.

### Paso 1

```text
DNI o código
```

### Paso 2

```text
Juan Pérez

[MARCAR ENTRADA]
```

o:

```text
Juan Pérez

Entrada: 08:03

[MARCAR SALIDA]
```

---

## Tests

- identificación por DNI;
- identificación por código;
- DNI inválido;
- check-in;
- doble check-in;
- check-out;
- check-out sin entrada;
- empleado inactivo;
- cálculo de minutos.

---

## Entregable

Un trabajador puede registrar una jornada completa.

---

# 12. FASE 7 — Panel de asistencia para jefes

## Objetivo

Permitir consultar lo registrado antes de implementar remuneración.

---

## Backend

Endpoint:

```text
GET /api/v1/attendance
```

Filtros:

```text
employee_id
date_from
date_to
status
```

---

## Frontend

Ruta:

```text
/admin/attendance
```

Tabla:

```text
Empleado
Fecha
Entrada
Salida
Trabajado
Esperado
Diferencia
Estado
```

---

## Dashboard

Actualizar:

```text
/admin/dashboard
```

Mostrar:

```text
Empleados activos
Presentes hoy
Sin entrada
Con salida
Entradas abiertas
```

---

## Entregable

Los jefes ya pueden utilizar el sistema como control básico de asistencia aunque payroll todavía no exista.

---

# 13. FASE 8 — Correcciones y auditoría inicial

## Objetivo

Permitir corregir errores sin perder trazabilidad.

---

## Módulo

```text
audit
```

---

## Modelo

```text
audit_logs
```

Campos:

```text
id
user_id
action
entity_type
entity_id
old_values
new_values
reason
created_at
```

---

## Corrección de asistencia

Endpoint:

```text
PATCH /api/v1/attendance/{id}
```

Debe pedir:

```text
reason
```

para cambios manuales.

---

## Ejemplo

```text
Salida original: NULL
Salida nueva: 18:05
Motivo: Olvidó marcar salida.
Usuario: jefe01
```

---

## Regla

No ocultar el valor anterior.

---

## Tests

- corrección válida;
- motivo obligatorio;
- auditoría creada;
- usuario no autorizado bloqueado.

---

# 14. FASE 9 — Diferencias, permisos y recuperación

## Objetivo

Resolver el caso real de trabajadores que recuperan horas.

---

## Módulo

```text
hour_adjustments
```

---

## Modelo

```text
id
employee_id
attendance_record_id nullable
adjustment_type
minutes
monetary_amount nullable
reason
status
approved_by
created_at
updated_at
```

---

## Tipos

```text
RECOVERY
OVERTIME
JUSTIFIED_PERMISSION
UNJUSTIFIED_ABSENCE
MANUAL_ADJUSTMENT
```

---

## Servicio

Crear:

```text
HourBalanceService
```

Responsable de:

```text
expected_minutes
worked_minutes
difference_minutes
pending_minutes
recovered_minutes
```

---

## Ejemplo

```text
Lunes
Esperado 480
Trabajado 360
Saldo -120
```

Jefe clasifica:

```text
PERMISO POR RECUPERAR
```

Martes:

```text
Esperado 480
Trabajado 540
Adicional +60
```

Jefe aplica:

```text
RECOVERY = 60
```

Saldo:

```text
-60
```

---

## Regla central

Una diferencia positiva no se convierte automáticamente en hora extra.

---

## Frontend

En detalle de asistencia:

```text
Clasificar diferencia
```

Opciones:

- recuperar;
- permiso justificado;
- ausencia;
- hora extra;
- ajuste.

---

## Tests

- saldo negativo;
- recuperación parcial;
- recuperación total;
- permiso justificado;
- ajuste manual.

---

# 15. FASE 10 — Detección y aprobación de horas extra

## Objetivo

Separar claramente tiempo adicional de tiempo pagable.

---

## Backend

Crear:

```text
OvertimeService
```

Debe distinguir:

```text
overtime_detected_minutes
overtime_approved_minutes
```

---

## Flujo

```text
Empleado trabaja más
    ↓
Backend detecta minutos adicionales
    ↓
Jefe revisa
    ↓
Decide:
    RECOVERY
    OVERTIME
    SALDO
    IGNORAR / AJUSTAR
```

---

## Métodos de cálculo

### Percentage

```text
base_rate × (1 + percentage/100)
```

---

### Fixed rate

```text
approved_hours × fixed_rate
```

---

### Manual

Monto ingresado por jefe.

---

## Frontend

Sección:

```text
Horas adicionales
```

Mostrar:

```text
Detectadas
Recuperadas
Aprobadas como extra
Pendientes
```

---

## Tests

- adicionales no aprobadas no pagan;
- porcentaje;
- tarifa fija;
- manual;
- recuperación priorizada manualmente;
- supervisor sin acceso monetario.

---

# 16. FASE 11 — Motor de cálculo salarial

## Objetivo

Construir el cálculo completo solamente después de estabilizar asistencia y ajustes.

---

## Módulo

```text
payroll
```

---

## Servicio central

Crear:

```text
PayrollCalculationService
```

Debe concentrar TODA la lógica monetaria.

No poner fórmulas en:

- routers;
- componentes React;
- páginas;
- SQL directamente.

---

## Inputs

```text
employee_id
period_start
period_end
```

---

## Datos utilizados

```text
salary_setting
schedule
attendance
hour_adjustments
overtime approvals
manual adjustments
```

---

## Resultado

```text
monthly_salary
expected_minutes
worked_minutes
pending_minutes
recovery_minutes
overtime_detected_minutes
overtime_approved_minutes
overtime_amount
deductions
manual_adjustments
total_amount
```

---

## Endpoint preview

```text
GET /api/v1/payroll/preview
```

Debe permitir revisar sin cerrar nada.

---

## Precisión

Dinero:

```text
Decimal
NUMERIC
```

Nunca:

```text
float
```

---

## Tests

Crear una suite fuerte para:

- mes completo;
- ausencia;
- permiso;
- recuperación;
- horas adicionales;
- porcentaje;
- tarifa fija;
- manual;
- cambio de sueldo dentro/fuera del periodo;
- redondeos.

---

# 17. FASE 12 — Periodos y cierre

## Objetivo

Evitar que pagos históricos cambien cuando se edita información futura.

---

## Modelos

```text
payroll_periods
payroll_records
```

---

## Estados

```text
OPEN
CALCULATED
CLOSED
```

---

## Flujo

```text
Crear periodo
    ↓
Preview
    ↓
Calcular
    ↓
Revisar
    ↓
Cerrar
```

---

## Al cerrar

Guardar snapshot:

```text
monthly_salary_snapshot
expected_minutes
worked_minutes
recovery_minutes
pending_minutes
overtime_approved_minutes
overtime_amount
deductions
manual_adjustments
total_amount
```

---

## Regla

Un periodo cerrado no debe recalcularse automáticamente.

Si se necesita corregir, debe existir un procedimiento explícito y auditado.

---

# 18. FASE 13 — Pantalla de remuneraciones

## Objetivo

Dar a jefes una vista clara del resultado.

---

## Ruta

```text
/admin/payroll
```

---

## Listado

```text
Empleado
Sueldo
Horas esperadas
Horas trabajadas
Saldo
Horas extra
Total
```

---

## Detalle

Mostrar:

```text
Periodo
Sueldo mensual
Horas esperadas
Horas trabajadas
Permisos
Recuperaciones
Saldo
Horas extra aprobadas
Monto horas extra
Ajustes
Total
```

---

## Permisos

Solo:

```text
ADMIN
BOSS
```

---

# 19. FASE 14 — Gestión de usuarios

## Objetivo

Completar la administración del acceso al sistema.

---

## Ruta

```text
/admin/users
```

---

## Funciones

- crear usuario;
- asignar rol;
- vincular empleado opcionalmente;
- activar/desactivar;
- cambiar contraseña;
- consultar último acceso.

---

## Regla

No permitir que un usuario sin permisos se autoeleve a ADMIN.

---

# 20. FASE 15 — Exportaciones

## Objetivo

Permitir uso administrativo fuera del sistema.

---

## Primera exportación

CSV.

---

## Asistencia

Campos:

```text
Empleado
DNI
Código
Cargo
Fecha
Entrada
Salida
Horas trabajadas
Horas esperadas
Diferencia
Estado
```

---

## Remuneración

Solo ADMIN/BOSS.

Campos:

```text
Empleado
Periodo
Sueldo mensual
Horas esperadas
Horas trabajadas
Saldo
Horas extra
Monto extra
Ajustes
Total
```

---

## Posterior

Excel real `.xlsx` puede añadirse cuando el MVP ya esté estable.

---

# 21. FASE 16 — Deploy de producción

## Objetivo

Pasar de entorno local a infraestructura real.

---

## Neon

Configurar:

```text
PostgreSQL production
```

---

## Railway

Deploy:

```text
backend/
```

Variables:

```text
DATABASE_URL
SECRET_KEY
ENVIRONMENT=production
FRONTEND_URL
TIMEZONE=America/Lima
```

---

## Vercel

Deploy:

```text
frontend/
```

Variable:

```text
NEXT_PUBLIC_API_URL
```

---

## CORS

Permitir únicamente:

```text
localhost durante desarrollo
dominio Vercel
dominio definitivo
```

---

## Migraciones

Aplicar Alembic en producción.

Nunca editar tablas manualmente salvo emergencia controlada.

---

# 22. FASE 17 — Estabilización

## Objetivo

No agregar funciones nuevas durante esta fase.

Solo:

- corregir bugs;
- reforzar permisos;
- revisar cálculos;
- revisar UX;
- comprobar logs;
- corregir errores de zona horaria;
- verificar datos reales.

---

## Pruebas con escenarios reales

### Escenario A

Empleado trabaja jornada normal.

---

### Escenario B

Empleado llega tarde.

---

### Escenario C

Empleado sale antes.

---

### Escenario D

Empleado pide permiso y recupera otro día.

---

### Escenario E

Empleado realiza horas adicionales.

---

### Escenario F

Jefe aprueba parte como hora extra.

---

### Escenario G

Empleado olvida marcar salida.

---

### Escenario H

Cambio de sueldo en un mes posterior.

---

### Escenario I

Supervisor intenta consultar salario.

Debe ser rechazado.

---

# 23. Orden de módulos resumido

Hermes debe seguir aproximadamente este orden:

```text
01. Core / configuración
02. Database
03. Auth
04. System roles
05. Job roles
06. Employees
07. Work schedules
08. Salary settings
09. Attendance
10. Attendance admin
11. Audit
12. Hour adjustments
13. Hour balance
14. Overtime
15. Payroll engine
16. Payroll periods
17. Payroll UI
18. Users admin
19. Export
20. Deploy
21. Stabilization
```

---

# 24. Dependencias entre módulos

```text
AUTH
 └── USERS
      └── PERMISSIONS

JOB ROLES
 └── EMPLOYEES
      ├── WORK SCHEDULES
      ├── SALARY SETTINGS
      └── ATTENDANCE
            ├── AUDIT
            ├── HOUR ADJUSTMENTS
            │    └── OVERTIME
            │
            └────────────┐
                         ▼
                    PAYROLL
                         │
                         ▼
                 PAYROLL PERIODS
```

No construir `payroll` antes de estabilizar:

```text
schedules
attendance
hour_adjustments
overtime
```

---

# 25. Regla de alcance

Si durante el desarrollo surge una función nueva, Hermes debe clasificarla.

## Si es necesaria para el MVP

Implementarla en la fase correspondiente.

---

## Si es útil pero no necesaria

Registrarla en:

```text
docs/backlog.md
```

---

## Si pertenece al ERP futuro

No desarrollarla.

Ejemplos:

```text
inventario
producción
ventas
mantenimiento
calidad
facturación
```

---

# 26. Backlog sugerido para después del MVP

No construir todavía:

```text
QR para empleados
app móvil
geolocalización
biometría
reconocimiento facial
notificaciones
vacaciones
CTS
AFP
ONP
planilla electrónica
boletas legales
SUNAT
producción
inventario
analytics avanzados
IA
```

---

# 27. Definition of Done por módulo

Un módulo se considera terminado cuando:

- [ ] Tiene modelo de datos.
- [ ] Tiene migración.
- [ ] Tiene schemas Pydantic.
- [ ] Tiene service/repository cuando corresponde.
- [ ] Tiene router.
- [ ] Tiene permisos.
- [ ] Tiene manejo de errores.
- [ ] Tiene tests.
- [ ] Tiene UI si es visible al usuario.
- [ ] Está documentado.
- [ ] No rompe tests anteriores.

---

# 28. Definition of Done del backend completo

- [ ] Todas las migraciones funcionan desde una base vacía.
- [ ] Tests pasan.
- [ ] No hay secretos en el repositorio.
- [ ] CORS está limitado.
- [ ] Las contraseñas están hasheadas.
- [ ] Los roles se verifican en backend.
- [ ] Los cálculos salariales están centralizados.
- [ ] El frontend no contiene reglas críticas.
- [ ] Auditoría funciona.
- [ ] Timestamps manejan correctamente America/Lima.

---

# 29. Definition of Done del frontend

- [ ] Responsive.
- [ ] Pantalla de marcación simple.
- [ ] Admin protegido.
- [ ] Estados de carga.
- [ ] Mensajes de error claros.
- [ ] Confirmación de entrada/salida.
- [ ] Tablas utilizables en laptop/tablet.
- [ ] Datos salariales ocultos para supervisor.
- [ ] No contiene secretos.
- [ ] No realiza cálculos salariales críticos.

---

# 30. Estrategia de pruebas

## Backend

Prioridad alta.

Usar:

```text
pytest
```

---

## Unit tests

Para servicios:

```text
ScheduleService
AttendanceService
HourBalanceService
OvertimeService
PayrollCalculationService
```

---

## Integration tests

Para:

```text
API + PostgreSQL
```

---

## Frontend

Al menos validar:

- login;
- marcación;
- crear empleado;
- listado;
- permisos visuales;
- payroll.

---

# 31. Orden recomendado de entrega interna

## Entrega 1

```text
Login
Usuarios base
Empleados
Cargos
```

Ya permite administrar personal.

---

## Entrega 2

```text
Jornadas
Marcación
Panel de asistencia
```

Ya funciona como sistema real de asistencia.

---

## Entrega 3

```text
Correcciones
Permisos
Recuperaciones
Saldo
```

Ya refleja la operación real.

---

## Entrega 4

```text
Horas extra
Sueldo
Payroll
```

Ya permite cálculo interno.

---

## Entrega 5

```text
Cierre de periodos
Exportación
Auditoría
Deploy final
```

MVP completo.

---

# 32. Prioridad funcional

Si se necesita reducir alcance por tiempo, conservar en este orden:

## Prioridad 1

```text
Empleados
Marcación
Asistencia
```

---

## Prioridad 2

```text
Jornadas
Saldo
Permisos
Recuperación
```

---

## Prioridad 3

```text
Sueldo
Horas extra
Payroll
```

---

## Prioridad 4

```text
Exportaciones
Auditoría avanzada
Mejoras visuales
```

---

# 33. Reglas que Hermes debe respetar durante todo el desarrollo

1. No mezclar cargos laborales con roles de acceso.
2. No usar DNI como contraseña administrativa.
3. No borrar empleados con historial.
4. No almacenar dinero en `float`.
5. No almacenar duración como decimal ambiguo.
6. No confiar en hora del navegador.
7. No calcular nómina en frontend.
8. No pagar horas adicionales automáticamente.
9. No descontar horas negativas automáticamente sin clasificación.
10. No sobrescribir sueldo histórico.
11. No sobrescribir jornada histórica.
12. Toda corrección sensible debe quedar auditada.
13. Payroll debe construirse después de asistencia.
14. Mantener módulos independientes.
15. Evitar sobreingeniería.
16. No agregar módulos del ERP todavía.

---

# 34. Resultado final esperado

Al terminar todas las fases:

```text
Empleado
    ↓
DNI / código
    ↓
Entrada / salida
    ↓
FastAPI
    ↓
Neon
    ↓
Horas trabajadas
    ↓
Comparación con jornada
    ↓
Permisos / recuperación / horas extra
    ↓
PayrollCalculationService
    ↓
Resultado salarial
    ↓
Panel privado de jefe
```

Infraestructura:

```text
Frontend → Vercel
Backend  → Railway
DB       → Neon
```

---

# 35. Enfoque para el ERP futuro

Este MVP debe quedar como:

```text
ERP Agua ReNew
└── Personal
    ├── Employees
    ├── Attendance
    ├── Work Schedules
    ├── Hour Adjustments
    └── Payroll interno
```

Después otros módulos podrán reutilizar:

```text
employee_id
```

en:

```text
Producción
Almacén
Incidentes
Mantenimiento
Calidad
Ventas
```

Por eso el objetivo no es crear un proyecto desechable, sino construir **el primer módulo estable del futuro ERP**, manteniendo el alcance actual pequeño.

---

# 36. Instrucción final para Hermes

Desarrollar el proyecto de manera incremental.

No implementar varias fases grandes simultáneamente.

Al cerrar cada fase:

```text
1. ejecutar migraciones;
2. ejecutar tests;
3. revisar permisos;
4. comprobar flujo manual;
5. documentar;
6. hacer commit;
7. recién entonces continuar.
```

Si una regla de negocio todavía no está definida, no inventar una política irreversible.

Preferir:

```text
configurable
```

o:

```text
pendiente de decisión del jefe
```

antes que asumir comportamientos salariales no confirmados.

El MVP debe mantenerse **simple para el usuario, modular para el desarrollador y reutilizable para el ERP futuro**.
