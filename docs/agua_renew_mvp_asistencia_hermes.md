# Agua ReNew — MVP de Asistencia y Cálculo de Sueldos

## 1. Propósito del documento

Este documento define el alcance funcional y técnico de un sistema web básico para **control de asistencia, horas trabajadas y cálculo interno de remuneraciones** de los empleados de Agua ReNew.

El sistema debe ser pequeño, fácil de usar y económico, pero su arquitectura debe quedar preparada para convertirse posteriormente en el **módulo de Personal / Asistencia del ERP completo de Agua ReNew**.

El objetivo principal del MVP es:

1. Permitir que un trabajador marque su **entrada** y **salida** usando su DNI o código interno.
2. Registrar de forma confiable las horas realmente trabajadas.
3. Permitir que los jefes creen y administren empleados.
4. Permitir configurar el sueldo mensual y la jornada pactada de cada empleado.
5. Calcular horas esperadas, horas trabajadas, diferencias y saldo de horas.
6. Permitir manejar permisos y recuperación de horas.
7. Detectar horas adicionales y permitir que un jefe decida si se consideran recuperación, saldo u horas extra.
8. Permitir configurar cómo se pagan las horas extra.
9. Mantener la información salarial visible únicamente para usuarios autorizados.
10. Mantener trazabilidad de los cambios realizados por administradores, jefes o supervisores.

---

# 2. Principios del MVP

Este sistema debe construirse siguiendo los siguientes principios.

## 2.1 Simplicidad para el trabajador

El trabajador no debe navegar por un sistema complejo.

Su flujo debe ser prácticamente:

```text
Abrir sistema
    ↓
Introducir DNI o código
    ↓
Sistema identifica trabajador
    ↓
Marcar entrada o salida
    ↓
Confirmación
```

El trabajador NO debe poder consultar:

- sueldo;
- cálculo salarial;
- sueldo de otros empleados;
- listado completo de trabajadores;
- panel administrativo;
- configuraciones;
- usuarios;
- roles;
- reportes administrativos.

---

## 2.2 Control para los jefes

Los usuarios autorizados deben tener acceso mediante usuario y contraseña.

Dependiendo de sus permisos podrán:

- consultar asistencia;
- crear empleados;
- editar empleados;
- desactivar empleados;
- configurar jornadas;
- configurar sueldo mensual;
- corregir registros de asistencia;
- registrar permisos;
- gestionar recuperación de horas;
- aprobar horas extra;
- configurar el cálculo de horas extra;
- consultar cálculos de remuneración;
- crear usuarios del sistema;
- administrar roles;
- consultar auditoría.

---

## 2.3 No borrar historial

Un empleado que deja de trabajar en la empresa no debe eliminarse.

Debe cambiarse a:

```text
INACTIVO
```

Se debe conservar:

- asistencia histórica;
- cálculos anteriores;
- permisos;
- ajustes;
- auditoría;
- datos salariales históricos asociados a periodos cerrados.

---

## 2.4 El backend es la fuente de verdad

El frontend NO debe calcular:

- horas trabajadas;
- saldo de horas;
- valor proporcional por hora;
- horas recuperadas;
- horas extra;
- descuentos;
- total de remuneración.

El frontend solo presenta resultados.

Toda regla importante debe ejecutarse en el backend FastAPI.

---

# 3. Stack tecnológico obligatorio

## Frontend

- **Next.js**
- **TypeScript**
- **React**
- **Tailwind CSS**
- Fetch / cliente HTTP tipado para consumir la API

Hosting:

- **Vercel**

---

## Backend

- **Python**
- **FastAPI**
- **Pydantic**
- **SQLAlchemy 2.x**
- **Alembic**
- **PostgreSQL driver compatible con Neon**
- **pytest**

Hosting:

- **Railway**

---

## Base de datos

- **PostgreSQL**
- Servicio: **Neon**

Neon será la base de datos principal y única del MVP.

---

## Repositorio

- GitHub

Se recomienda inicialmente un monorepo:

```text
agua-renew-erp/
│
├── frontend/
│   └── Next.js
│
├── backend/
│   └── FastAPI
│
├── docs/
│   └── especificaciones
│
└── README.md
```

Aunque el sistema inicialmente sea únicamente de asistencia, el repositorio debe considerarse el inicio del ERP.

---

# 4. Arquitectura general

```text
┌─────────────────────────────┐
│          EMPLEADO           │
│   DNI / código / entrada    │
│           salida            │
└──────────────┬──────────────┘
               │
               │ HTTPS
               ▼
┌─────────────────────────────┐
│          FRONTEND           │
│        Next.js              │
│        Vercel               │
└──────────────┬──────────────┘
               │
               │ REST API
               ▼
┌─────────────────────────────┐
│          BACKEND            │
│          FastAPI            │
│          Railway            │
│                             │
│ - autenticación             │
│ - empleados                 │
│ - asistencia                │
│ - jornadas                  │
│ - permisos                  │
│ - horas extra               │
│ - remuneraciones            │
│ - auditoría                 │
└──────────────┬──────────────┘
               │
               │ PostgreSQL
               ▼
┌─────────────────────────────┐
│            NEON             │
│         PostgreSQL          │
└─────────────────────────────┘
```

---

# 5. Separación entre empleados y usuarios

Este punto es importante.

## 5.1 Empleado

Un empleado es una persona registrada laboralmente.

Ejemplo:

```text
Nombre: Juan Pérez
DNI: 72845632
Código interno: EMP-001
Cargo: Operario
Sueldo mensual: S/ 1,500
Jornada: 8 horas
```

Un empleado NO necesita tener una cuenta del sistema.

La mayoría de operarios solamente usarán su DNI o código para marcar asistencia.

---

## 5.2 Usuario del sistema

Un usuario es alguien autorizado a iniciar sesión en el panel administrativo.

Ejemplos:

- administrador;
- jefe;
- supervisor.

Un usuario puede estar vinculado a un empleado, pero no es obligatorio que toda persona registrada como empleado tenga usuario.

---

# 6. Roles de acceso al sistema

Para el MVP se manejarán tres roles principales.

## ADMIN

Acceso completo.

Puede:

- gestionar empleados;
- gestionar cargos laborales;
- consultar asistencia;
- corregir asistencia;
- gestionar jornadas;
- consultar sueldos;
- modificar configuraciones salariales;
- gestionar horas extra;
- gestionar permisos;
- gestionar usuarios;
- gestionar roles;
- consultar auditoría;
- modificar configuración general.

---

## JEFE

Puede:

- consultar empleados;
- crear empleados;
- editar empleados;
- consultar asistencia;
- corregir asistencia;
- gestionar permisos;
- gestionar recuperación de horas;
- consultar salarios;
- configurar sueldo;
- configurar horas extra;
- aprobar horas extra;
- consultar cálculos de remuneración.

No necesariamente debe poder administrar usuarios del sistema.

---

## SUPERVISOR

Puede:

- consultar empleados;
- consultar asistencia;
- registrar o corregir incidencias autorizadas;
- registrar observaciones.

NO puede ver:

- sueldo mensual;
- cálculo de sueldo;
- configuración salarial;
- monto de horas extra;
- total a pagar;
- usuarios administrativos.

---

# 7. Roles o cargos laborales

Los cargos laborales son diferentes a los roles de acceso.

Ejemplos:

```text
Operario
Producción
Almacén
Chofer
Ayudante
Ventas
Administrativo
Supervisor de planta
Técnico de mantenimiento
```

El sistema debe permitir crear nuevos cargos desde el panel.

Entidad sugerida:

```text
job_roles
```

Campos:

```text
id
name
description
active
created_at
updated_at
```

---

# 8. Gestión de empleados

El panel administrativo debe tener:

```text
Empleados
    ├── Listado
    ├── Nuevo empleado
    └── Detalle / edición
```

## Datos mínimos del empleado

```text
id
first_name
last_name
dni
employee_code
job_role_id
hire_date
termination_date
active
created_at
updated_at
```

Reglas:

- DNI debe ser único.
- Código interno debe ser único.
- No eliminar empleados con historial.
- Un empleado cesado se marca como inactivo.
- El código interno puede generarse automáticamente o ingresarse manualmente.

---

# 9. Configuración laboral del empleado

Cada empleado debe poder tener su propia configuración.

## Datos básicos

```text
monthly_salary
work_schedule
overtime_enabled
overtime_method
overtime_value
```

Ejemplo:

```text
Empleado: Juan Pérez
Sueldo mensual: S/ 1,500

Jornada:
Lunes       8 h
Martes      8 h
Miércoles   8 h
Jueves      8 h
Viernes     8 h
Sábado      8 h
Domingo     0 h
```

No asumir que todos los trabajadores tienen la misma jornada.

---

# 10. Jornada laboral

No guardar únicamente:

```text
8 horas por día
```

Guardar la distribución semanal.

Ejemplo:

```text
monday_minutes = 480
tuesday_minutes = 480
wednesday_minutes = 480
thursday_minutes = 480
friday_minutes = 480
saturday_minutes = 480
sunday_minutes = 0
```

Internamente se recomienda trabajar en **minutos**.

No utilizar números decimales para representar tiempo.

Ejemplo incorrecto:

```text
7.50 horas
```

Ejemplo correcto:

```text
450 minutos
```

---

# 11. Marcación del trabajador

Ruta pública sugerida:

```text
/
```

o:

```text
/asistencia
```

La pantalla debe estar optimizada para tablet, celular y PC.

## Pantalla inicial

```text
CONTROL DE ASISTENCIA

DNI o código
[________________]

[ CONTINUAR ]
```

Después de identificar al empleado:

```text
Juan Pérez
Operario

25 de agosto de 2026
08:03

[ MARCAR ENTRADA ]
```

Si ya tiene una entrada abierta:

```text
Juan Pérez

Entrada registrada:
08:03

[ MARCAR SALIDA ]
```

---

# 12. Reglas de marcación

## Entrada

No permitir dos entradas abiertas consecutivas.

Ejemplo:

```text
08:00 Entrada
08:05 Entrada
```

La segunda debe rechazarse.

---

## Salida

No permitir marcar salida sin una entrada abierta.

---

## Hora del servidor

La hora válida debe ser la del backend.

NO confiar en la hora enviada por el navegador.

Zona horaria:

```text
America/Lima
```

Guardar preferiblemente timestamps en UTC y convertir a America/Lima para presentación y reglas locales.

---

# 13. Modelo recomendado para asistencia

Tabla:

```text
attendance_records
```

Campos sugeridos:

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

`worked_minutes` puede calcularse cuando se registra la salida.

Sin embargo, las marcas originales `check_in_at` y `check_out_at` son la fuente principal.

---

# 14. Cálculo de horas trabajadas

Ejemplo:

```text
Entrada: 08:00
Salida: 17:00
```

Resultado:

```text
540 minutos
```

Si existe refrigerio configurable:

```text
540 - 60 = 480 minutos pagables
```

Para el primer MVP, el descuento de refrigerio puede configurarse por jornada o empleado si la empresa lo necesita.

No implementar reglas legales complejas de refrigerio si no han sido definidas por la empresa.

---

# 15. Horas esperadas

El backend debe calcular para cada fecha cuántos minutos debía trabajar el empleado según su jornada.

Ejemplo:

```text
Lunes esperado = 480 min
Trabajado = 360 min

Diferencia = -120 min
```

---

# 16. Saldo de horas

Este concepto es fundamental.

No considerar automáticamente una jornada incompleta como descuento.

Ejemplo:

## Lunes

```text
Esperado: 8 h
Trabajado: 6 h
Diferencia: -2 h
```

El empleado pide permiso para recuperar esas horas.

Saldo:

```text
-2 h
```

## Martes

```text
Esperado: 8 h
Trabajado: 9 h
Diferencia: +1 h
```

Saldo:

```text
-1 h
```

## Miércoles

```text
Esperado: 8 h
Trabajado: 9 h
Diferencia: +1 h
```

Saldo:

```text
0 h
```

El sistema debe permitir reflejar este comportamiento.

---

# 17. Diferencias de horas

Cuando existan diferencias se debe poder clasificar.

Tipos iniciales:

```text
RECOVERY
OVERTIME
JUSTIFIED_PERMISSION
UNJUSTIFIED_ABSENCE
MANUAL_ADJUSTMENT
```

También pueden utilizarse estados más amigables en frontend:

```text
Recuperación
Hora extra
Permiso justificado
Ausencia
Ajuste manual
```

---

# 18. Permisos

Si un trabajador trabaja menos horas porque recibió permiso, el jefe debe poder indicar:

```text
Permiso por recuperar
```

o:

```text
Permiso justificado
```

o:

```text
Ausencia / descuento
```

No asumir automáticamente qué tratamiento corresponde.

---

# 19. Recuperación de horas

Cuando un trabajador tenga saldo negativo y posteriormente trabaje más tiempo que su jornada esperada, el sistema debe detectar minutos adicionales.

Ejemplo:

```text
Saldo pendiente: -120 min

Hoy:
Esperado: 480 min
Trabajado: 540 min

Adicional detectado: +60 min
```

El jefe puede asignar esos 60 minutos a:

```text
RECOVERY
```

Nuevo saldo:

```text
-60 min
```

No considerar automáticamente esos 60 minutos como horas extra pagadas.

---

# 20. Horas adicionales detectadas

El sistema debe distinguir:

```text
horas adicionales detectadas
```

de:

```text
horas extra aprobadas
```

Ejemplo:

```text
Horas adicionales detectadas: 6 h
Horas usadas en recuperación: 2 h
Horas extra aprobadas: 3 h
Saldo positivo restante: 1 h
```

El backend detecta.

El jefe decide.

---

# 21. Configuración de horas extra

Debe ser configurable.

## Opción 1 — Porcentaje

Ejemplo:

```text
Recargo: 25 %
```

Si el valor base interno de la hora fuera:

```text
S/ 8.00
```

la hora extra será:

```text
8 × 1.25 = S/ 10
```

---

## Opción 2 — Monto fijo

Ejemplo:

```text
Hora extra = S/ 12
```

---

## Opción 3 — Ajuste manual

El jefe puede ingresar directamente:

```text
Monto horas extra = S/ 90
```

---

## Configuración sugerida

```text
overtime_enabled: bool

overtime_method:
PERCENTAGE
FIXED_RATE
MANUAL

overtime_percentage
overtime_fixed_rate
```

---

# 22. Sueldo mensual

El dato principal configurado por el jefe será:

```text
monthly_salary
```

Ejemplo:

```text
S/ 1,500
```

El backend puede obtener internamente un valor proporcional por minuto u hora cuando sea necesario.

Ese valor no debe ser ingresado manualmente como dato principal.

---

# 23. Cálculo salarial

El sistema NO debe modificar el sueldo cada día.

Debe calcular dinámicamente a partir de:

- sueldo mensual;
- jornada configurada;
- horas esperadas;
- asistencia;
- permisos;
- recuperaciones;
- ausencias;
- horas extra aprobadas;
- ajustes manuales.

El periodo puede ser:

```text
01/08/2026 - 31/08/2026
```

Ejemplo de resumen:

```text
Sueldo mensual               S/ 1,500
Horas esperadas              192 h
Horas trabajadas             198 h
Saldo pendiente                0 h
Horas adicionales detectadas   6 h
Horas recuperadas              2 h
Horas extra aprobadas          4 h
Monto horas extra             S/ 50
Otros ajustes                 S/ 0

Total calculado               S/ 1,550
```

La fórmula exacta para descuentos debe estar encapsulada en un servicio del backend y no dispersa en rutas o frontend.

---

# 24. Periodos de remuneración

Tabla sugerida:

```text
payroll_periods
```

Debe permitir periodos como:

```text
2026-08-01
2026-08-31
```

Estados recomendados:

```text
OPEN
CALCULATED
CLOSED
```

Mientras esté:

```text
OPEN
```

los resultados pueden recalcularse.

Cuando un periodo se cierre, debe quedar guardado un snapshot de los valores finales para evitar que una modificación posterior altere silenciosamente un pago histórico.

---

# 25. Correcciones de asistencia

Los jefes pueden corregir errores como:

```text
Entrada registrada: 08:10
Entrada correcta: 08:00
```

o:

```text
Trabajador olvidó marcar salida.
```

Toda corrección debe pedir:

```text
Motivo
```

Ejemplo:

```text
Olvidó marcar salida al terminar turno.
```

Y generar auditoría.

---

# 26. Auditoría

Tabla:

```text
audit_logs
```

Campos sugeridos:

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

Ejemplo:

```text
Usuario: admin
Acción: UPDATE_ATTENDANCE
Empleado: Juan Pérez
Anterior: salida = NULL
Nuevo: salida = 18:03
Motivo: trabajador olvidó marcar salida
Fecha: 25/08/2026 18:20
```

Usar JSONB para `old_values` y `new_values` si es conveniente.

---

# 27. Modelo de datos inicial

El MVP debería contemplar al menos las siguientes entidades.

```text
users
system_roles
job_roles
employees
work_schedules
attendance_records
hour_adjustments
salary_settings
payroll_periods
payroll_records
audit_logs
```

---

# 28. Tabla users

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

Nunca guardar contraseñas en texto plano.

Usar hash seguro.

---

# 29. Tabla system_roles

Inicialmente:

```text
ADMIN
BOSS
SUPERVISOR
```

No confundir con cargos laborales.

---

# 30. Tabla employees

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

# 31. Tabla work_schedules

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

`effective_from` y `effective_to` permiten cambios futuros de jornada sin destruir el historial.

---

# 32. Tabla salary_settings

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

También debe ser histórica.

Si el empleado pasa de:

```text
S/ 1,300
```

a:

```text
S/ 1,500
```

no se debe sobrescribir el salario anterior de forma que cambie los cálculos históricos.

---

# 33. Tabla hour_adjustments

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

Estados sugeridos:

```text
PENDING
APPROVED
REJECTED
```

---

# 34. Tabla payroll_records

Cuando un periodo se cierre se recomienda guardar:

```text
id
payroll_period_id
employee_id

monthly_salary_snapshot
expected_minutes
worked_minutes
recovery_minutes
pending_minutes
overtime_detected_minutes
overtime_approved_minutes
overtime_amount
deductions
manual_adjustments
total_amount

calculated_at
closed_at
```

Esto crea un snapshot histórico.

---

# 35. Autenticación

Solo el panel administrativo necesita autenticación.

Ruta sugerida:

```text
/admin/login
```

No usar DNI del trabajador como autenticación administrativa.

El trabajador utiliza DNI o código exclusivamente para marcar asistencia.

---

# 36. Seguridad de contraseñas

Usar un algoritmo seguro soportado en Python.

Ejemplo:

```text
Argon2
```

o una alternativa moderna apropiada.

No:

```text
MD5
SHA1
SHA256 directo
```

---

# 37. Sesiones

Para este sistema se recomienda utilizar sesiones o JWT en cookie:

```text
HttpOnly
Secure
SameSite
```

Evitar guardar tokens sensibles en `localStorage` si no es necesario.

---

# 38. Endpoints iniciales

Las rutas son orientativas.

## Auth

```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

---

## Marcación pública

```text
POST /api/v1/attendance/identify
POST /api/v1/attendance/check-in
POST /api/v1/attendance/check-out
```

Ejemplo:

```json
{
  "identifier": "72845632"
}
```

El identificador puede ser:

- DNI;
- código interno.

---

## Empleados

```text
GET    /api/v1/employees
POST   /api/v1/employees
GET    /api/v1/employees/{id}
PATCH  /api/v1/employees/{id}
POST   /api/v1/employees/{id}/deactivate
```

No es obligatorio exponer DELETE.

---

## Cargos

```text
GET   /api/v1/job-roles
POST  /api/v1/job-roles
PATCH /api/v1/job-roles/{id}
```

---

## Jornadas

```text
GET  /api/v1/employees/{id}/schedule
POST /api/v1/employees/{id}/schedule
```

---

## Salario

```text
GET  /api/v1/employees/{id}/salary-settings
POST /api/v1/employees/{id}/salary-settings
```

Solo roles autorizados.

---

## Asistencia

```text
GET   /api/v1/attendance
GET   /api/v1/attendance/{id}
PATCH /api/v1/attendance/{id}
```

PATCH debe generar auditoría cuando cambie una marca.

---

## Ajustes

```text
POST /api/v1/hour-adjustments
PATCH /api/v1/hour-adjustments/{id}
```

---

## Remuneración

```text
GET  /api/v1/payroll/preview
POST /api/v1/payroll/periods
GET  /api/v1/payroll/periods/{id}
POST /api/v1/payroll/periods/{id}/calculate
POST /api/v1/payroll/periods/{id}/close
```

---

## Usuarios

```text
GET    /api/v1/users
POST   /api/v1/users
PATCH  /api/v1/users/{id}
POST   /api/v1/users/{id}/deactivate
```

ADMIN únicamente, salvo decisión posterior.

---

# 39. Organización del backend

Arquitectura modular.

```text
backend/
│
├── app/
│   ├── main.py
│   │
│   ├── core/
│   │   ├── config.py
│   │   ├── security.py
│   │   ├── permissions.py
│   │   └── timezone.py
│   │
│   ├── db/
│   │   ├── base.py
│   │   ├── session.py
│   │   └── migrations/
│   │
│   ├── modules/
│   │   │
│   │   ├── auth/
│   │   ├── users/
│   │   ├── employees/
│   │   ├── job_roles/
│   │   ├── schedules/
│   │   ├── attendance/
│   │   ├── hour_adjustments/
│   │   ├── payroll/
│   │   └── audit/
│   │
│   └── shared/
│
├── tests/
├── alembic/
├── alembic.ini
├── pyproject.toml
└── Dockerfile
```

Cada módulo debería separar, cuando sea razonable:

```text
models.py
schemas.py
repository.py
service.py
router.py
```

Evitar colocar toda la lógica en `main.py`.

---

# 40. Organización del frontend

```text
frontend/
│
├── app/
│   ├── page.tsx
│   │
│   ├── admin/
│   │   ├── login/
│   │   ├── dashboard/
│   │   ├── employees/
│   │   ├── attendance/
│   │   ├── payroll/
│   │   ├── users/
│   │   ├── roles/
│   │   └── settings/
│   │
│   └── layout.tsx
│
├── components/
├── lib/
│   ├── api/
│   ├── auth/
│   └── utils/
│
└── types/
```

---

# 41. Pantallas del MVP

## Pantalla pública

### Asistencia

Debe permitir:

- ingresar DNI/código;
- identificar empleado;
- marcar entrada;
- marcar salida;
- mostrar confirmación.

---

## Panel administrativo

### Login

```text
Usuario
Contraseña
```

---

### Dashboard

Datos básicos:

```text
Empleados activos
Presentes hoy
Sin entrada
Con salida registrada
Entradas abiertas
```

Listado resumido del día.

---

### Empleados

Tabla:

```text
Nombre
DNI
Código
Cargo
Estado
Acciones
```

Botón:

```text
+ Nuevo empleado
```

---

### Detalle de empleado

Secciones:

```text
Datos personales
Jornada
Sueldo
Asistencia
Saldo de horas
Horas extra
```

---

### Asistencia

Filtros:

```text
Empleado
Fecha desde
Fecha hasta
Estado
```

Columnas:

```text
Empleado
Fecha
Entrada
Salida
Horas trabajadas
Horas esperadas
Diferencia
Estado
```

---

### Sueldos

Filtros:

```text
Periodo
Empleado
```

Mostrar:

```text
Sueldo mensual
Horas esperadas
Horas trabajadas
Saldo
Horas recuperadas
Horas extra aprobadas
Monto horas extra
Ajustes
Total calculado
```

---

### Usuarios

Solo roles autorizados.

Permitir:

- crear usuario;
- asignar rol;
- desactivar usuario;
- cambiar contraseña.

---

### Roles laborales

Permitir:

- crear;
- editar;
- desactivar.

---

# 42. Cálculo dinámico

No duplicar cálculos en frontend y backend.

Crear un servicio central, por ejemplo:

```text
PayrollCalculationService
```

Responsable de:

```text
expected_minutes
worked_minutes
hour_balance
recovery_minutes
overtime_detected
overtime_approved
overtime_amount
deductions
total
```

Y otro servicio:

```text
AttendanceService
```

Responsable de:

```text
check-in
check-out
validaciones
worked_minutes
```

---

# 43. Precisión monetaria

Nunca usar `float` para dinero.

En Python:

```text
Decimal
```

En PostgreSQL:

```text
NUMERIC
```

Ejemplo:

```text
NUMERIC(12, 2)
```

---

# 44. Tiempo

Trabajar internamente con:

```text
minutos
```

para duración.

Y:

```text
timestamp with time zone
```

para marcas.

No calcular remuneración usando strings tipo:

```text
"8:30"
```

---

# 45. Casos especiales del MVP

## Empleado olvida salida

El jefe corrige.

Debe quedar auditado.

---

## Empleado marca doble entrada

Rechazar.

---

## Empleado intenta salida sin entrada

Rechazar.

---

## DNI inexistente

Mostrar:

```text
Trabajador no encontrado.
Verifique su DNI o código.
```

No revelar información adicional.

---

## Empleado inactivo

No permitir marcación.

---

## Trabajo adicional

Detectar.

No pagar automáticamente.

Esperar clasificación/aprobación.

---

## Saldo negativo

No descontar automáticamente mientras su tratamiento esté pendiente.

---

# 46. Exportación

Aunque puede implementarse después de las funciones centrales, dejar preparado un endpoint para exportar asistencia.

Formato inicial:

```text
CSV
```

y posteriormente:

```text
Excel
```

Datos:

```text
Empleado
DNI
Cargo
Fecha
Entrada
Salida
Horas trabajadas
Horas esperadas
Diferencia
Estado
```

La exportación salarial debe requerir permisos de jefe/admin.

---

# 47. Despliegue

## Frontend — Vercel

Proyecto:

```text
frontend
```

Variable:

```text
NEXT_PUBLIC_API_URL=https://<backend>.up.railway.app
```

---

## Backend — Railway

Ejecutar FastAPI.

Variables mínimas:

```text
DATABASE_URL=
SECRET_KEY=
ENVIRONMENT=
FRONTEND_URL=
TIMEZONE=America/Lima
```

No guardar secretos en GitHub.

---

## Base de datos — Neon

Railway se conecta a Neon mediante:

```text
DATABASE_URL
```

Usar conexión SSL requerida por Neon.

---

# 48. CORS

FastAPI debe aceptar únicamente los orígenes conocidos.

Desarrollo:

```text
http://localhost:3000
```

Producción:

```text
https://<frontend-vercel>.vercel.app
```

y posteriormente el dominio oficial.

No usar:

```text
*
```

en producción si se utilizan credenciales/cookies.

---

# 49. Migraciones

Toda modificación del esquema debe realizarse mediante Alembic.

Flujo:

```text
Modificar modelos
    ↓
Crear migración
    ↓
Revisar migración
    ↓
Aplicar migración
```

No depender de `create_all()` como estrategia de producción.

---

# 50. Seed inicial

Crear mecanismo de seed para:

```text
system_roles:
ADMIN
BOSS
SUPERVISOR
```

Y permitir crear el primer administrador de manera segura.

Nunca incluir una contraseña real fija en el repositorio.

---

# 51. Pruebas mínimas del backend

Crear tests para:

## Asistencia

- entrada válida;
- doble entrada rechazada;
- salida válida;
- salida sin entrada rechazada;
- empleado inexistente;
- empleado inactivo;
- cálculo de minutos.

## Permisos

- supervisor no ve salarios;
- jefe sí ve salarios;
- usuario no autenticado no accede a admin;
- empleado público no puede consultar información salarial.

## Cálculo

- jornada completa;
- jornada incompleta;
- recuperación;
- saldo negativo;
- saldo cero;
- adicional detectado;
- hora extra por porcentaje;
- hora extra por monto fijo.

---

# 52. Seguridad básica

Implementar:

- password hashing;
- autorización por roles;
- validación Pydantic;
- queries mediante ORM;
- secretos mediante variables de entorno;
- HTTPS en producción;
- cookies seguras si se usan sesiones;
- auditoría de cambios sensibles;
- rate limiting básico en marcación pública si resulta necesario.

---

# 53. Lo que NO debe entrar en este MVP

No desarrollar todavía:

- AFP;
- ONP;
- CTS;
- gratificaciones;
- vacaciones;
- boletas oficiales;
- contratos;
- SUNAT;
- planilla electrónica;
- contabilidad;
- reclutamiento;
- evaluaciones de desempeño;
- biometría;
- reconocimiento facial;
- geolocalización;
- app móvil nativa;
- producción;
- inventario;
- ventas;
- mantenimiento;
- IA.

Este MVP no pretende reemplazar un sistema legal de planillas.

Es una herramienta interna para:

```text
ASISTENCIA
+
HORAS
+
SALDO
+
HORAS EXTRA
+
CÁLCULO INTERNO
```

---

# 54. Preparación para el ERP futuro

El diseño debe permitir que `employees.id` sea utilizado posteriormente por otros módulos.

Ejemplo:

```text
employees
│
├── attendance_records
├── payroll_records
├── production_shifts
├── production_records
├── incidents
├── cleaning_records
├── warehouse_movements
└── maintenance_records
```

Por eso no crear un modelo aislado o descartable para asistencia.

---

# 55. Orden recomendado de implementación para Hermes

## Fase 1 — Base del proyecto

1. Crear monorepo.
2. Configurar backend FastAPI.
3. Configurar frontend Next.js.
4. Configurar variables de entorno.
5. Conectar FastAPI con Neon.
6. Configurar SQLAlchemy.
7. Configurar Alembic.
8. Crear health check.

Endpoint:

```text
GET /health
```

Resultado:

```json
{
  "status": "ok"
}
```

---

## Fase 2 — Autenticación y permisos

1. Crear `users`.
2. Crear `system_roles`.
3. Seed de roles.
4. Login.
5. Logout.
6. Sesión/JWT.
7. middleware/dependencies de autorización.
8. Tests de permisos.

---

## Fase 3 — Empleados

1. Crear `job_roles`.
2. Crear `employees`.
3. CRUD de cargos.
4. Crear/listar/editar/desactivar empleados.
5. Pantallas administrativas correspondientes.

---

## Fase 4 — Jornadas y salario

1. Crear `work_schedules`.
2. Crear `salary_settings`.
3. Manejar vigencia histórica.
4. Formularios de configuración.

---

## Fase 5 — Asistencia

1. Identificación por DNI/código.
2. Check-in.
3. Check-out.
4. Validaciones.
5. Pantalla pública.
6. Listado administrativo.
7. Correcciones auditadas.

---

## Fase 6 — Saldo y ajustes

1. Crear `hour_adjustments`.
2. Diferencia esperada vs trabajada.
3. Permisos.
4. Recuperaciones.
5. Ajustes manuales.
6. Aprobaciones.

---

## Fase 7 — Horas extra

1. Detectar horas adicionales.
2. Separar detección de aprobación.
3. Porcentaje.
4. Tarifa fija.
5. Monto manual.
6. Cálculo centralizado.

---

## Fase 8 — Remuneración

1. Crear periodos.
2. Preview.
3. Cálculo.
4. Snapshot.
5. Cierre.
6. Pantalla administrativa.

---

## Fase 9 — Exportación y auditoría

1. Exportación CSV.
2. Auditoría administrativa.
3. filtros.
4. revisión de permisos.

---

# 56. Criterios de aceptación del MVP

El MVP se considera funcional cuando se cumplan todos estos puntos.

## Marcación

- [ ] Un empleado activo puede identificarse con DNI.
- [ ] Un empleado activo puede identificarse con código.
- [ ] Puede marcar entrada.
- [ ] Puede marcar salida.
- [ ] No puede marcar entrada dos veces seguidas.
- [ ] No puede marcar salida sin entrada.
- [ ] Un empleado inactivo no puede marcar.

## Empleados

- [ ] ADMIN/JEFE puede crear empleados.
- [ ] Puede asignar cargo.
- [ ] Puede configurar jornada.
- [ ] Puede configurar sueldo mensual.
- [ ] Puede editar información.
- [ ] Puede desactivar empleados.
- [ ] El historial no se elimina.

## Usuarios

- [ ] Existe login administrativo.
- [ ] ADMIN puede crear usuarios.
- [ ] Existen roles ADMIN/BOSS/SUPERVISOR.
- [ ] Los permisos se validan en backend.

## Privacidad salarial

- [ ] Trabajadores no pueden consultar salarios.
- [ ] Supervisor no puede consultar salarios.
- [ ] Jefe/Admin sí pueden consultar salarios.

## Horas

- [ ] Se calculan minutos trabajados.
- [ ] Se calculan minutos esperados.
- [ ] Se calcula diferencia.
- [ ] Se puede registrar recuperación.
- [ ] Se puede registrar permiso.
- [ ] Se puede mantener saldo pendiente.

## Horas extra

- [ ] Se detectan horas adicionales.
- [ ] No se pagan automáticamente.
- [ ] El jefe puede aprobarlas.
- [ ] Puede utilizar porcentaje.
- [ ] Puede utilizar tarifa fija.
- [ ] Puede utilizar ajuste manual.

## Remuneración

- [ ] Existe cálculo por periodo.
- [ ] El sueldo mensual es la base.
- [ ] Se muestran horas esperadas.
- [ ] Se muestran horas trabajadas.
- [ ] Se muestran recuperaciones.
- [ ] Se muestran horas extra aprobadas.
- [ ] Se calcula monto de horas extra.
- [ ] Se obtiene total.
- [ ] Periodos cerrados conservan snapshot.

## Auditoría

- [ ] Correcciones de asistencia quedan registradas.
- [ ] Cambios sensibles identifican usuario.
- [ ] Se registra fecha/hora.
- [ ] Se registra motivo cuando corresponde.

---

# 57. Decisiones técnicas que Hermes NO debe cambiar sin justificación

1. **Frontend:** Next.js + TypeScript.
2. **Backend:** FastAPI + Python.
3. **DB:** PostgreSQL en Neon.
4. **Frontend hosting:** Vercel.
5. **Backend hosting:** Railway.
6. **ORM:** SQLAlchemy.
7. **Migraciones:** Alembic.
8. El frontend NO calcula salarios.
9. DNI/código NO equivale a contraseña administrativa.
10. Empleados y usuarios son entidades diferentes.
11. Cargos laborales y roles del sistema son conceptos diferentes.
12. No borrar empleados con historial.
13. No pagar automáticamente toda hora adicional.
14. No descontar automáticamente una diferencia negativa sin clasificación.
15. Los cambios de sueldo y jornada deben preservar historial.
16. La lógica principal debe quedar modular para integrarse al ERP futuro.

---

# 58. Prioridad de diseño

La prioridad no es construir un ERP completo ahora.

La prioridad es:

```text
1. Que sea fácil de usar.
2. Que marque correctamente.
3. Que los datos sean confiables.
4. Que los sueldos sean privados.
5. Que el cálculo sea comprensible.
6. Que los jefes mantengan el control.
7. Que no haya que desechar el backend al construir el ERP.
```

---

# 59. Resultado esperado

Al finalizar el MVP debemos tener:

```text
Empleado
   ↓
DNI / código
   ↓
Entrada / salida
   ↓
FastAPI registra
   ↓
PostgreSQL conserva historial
   ↓
Backend calcula horas
   ↓
Jefe revisa diferencias
   ↓
Clasifica permisos / recuperación / extra
   ↓
Backend calcula remuneración
   ↓
Jefe visualiza el resultado
```

El empleado mantiene una experiencia extremadamente sencilla, mientras que los jefes tienen la información necesaria para administrar asistencia y remuneraciones.

La arquitectura debe considerarse el inicio del futuro ERP de Agua ReNew, pero **el alcance de esta entrega sigue siendo únicamente el MVP de asistencia y cálculo interno de remuneraciones**.
