"""Valores unitarios de ley (Perú) y divisores fijos de planilla.

Base legal
----------
- **D.S. 003-97-TR, art. 8** (TUO del D. Leg. 728, remuneración): fuente primaria
  del valor día. La remuneración mensual se valora en treintavos (÷30) y la
  quincenal en quinceavos (÷15), con independencia de la longitud del mes.
- **D.S. 012-92-TR, art. 2** (reglamento del D.L. 713, descansos remunerados):
  "En caso de inasistencia de los trabajadores remunerados por quincena o
  mensualmente, el descuento proporcional del día de descanso semanal se
  efectúa dividiendo la remuneración ordinaria percibida en el mes o quincena
  entre treinta (30) o quince (15) días, respectivamente. **El resultado es el
  valor día.**"
- **D.S. 007-2002-TR, art. 12** (TUO de la Ley de Jornada de Trabajo, Horario y
  Trabajo en Sobretiempo): "Para efectos de calcular el recargo o sobretasa, el
  valor de hora es igual a la remuneración de un día dividida entre el número de
  horas de la jornada del respectivo trabajador."
- **D.L. 713, art. 3**: quien labore en su día de descanso sin sustituirlo por
  otro día en la misma semana percibe la retribución de la labor efectuada más
  una sobretasa del 100%.
- **D.L. 713, art. 4**: la remuneración del descanso semanal equivale a una
  jornada ordinaria y se abona en proporción a los días efectivamente
  trabajados; su cómputo para remuneraciones quincenales o mensuales lo fija el
  reglamento (divisores 15 y 30).

Regla del sistema
-----------------
El divisor es **fijo**: 30 para el mes y 15 para la quincena. Ningún valor
unitario (día u hora) se obtiene con los días calendario del mes, de modo que
febrero (28 o 29 días), un mes de 30 días y uno de 31 producen el mismo valor
día y el mismo valor hora.

El sueldo mensual remunera el mes completo, incluidos el descanso semanal y los
feriados no laborados: el valor día sirve para valorar descansos, feriados,
horas y descuentos, no para multiplicar días calendario sueltos (un mes de 31
días no paga 31/30 del sueldo ni uno de 28 paga 28/30).
"""

from decimal import Decimal, ROUND_HALF_UP

_CENTS = Decimal("0.01")
_RATE = Decimal("0.0001")

# Divisores legales. No dependen de la longitud del mes.
LEGAL_MONTH_DAYS = Decimal(30)
LEGAL_FORTNIGHT_DAYS = Decimal(15)


def daily_value(monthly_salary: Decimal) -> Decimal:
    """Valor día legal: remuneración mensual / 30 (D.S. 003-97-TR, art. 8).

    Es la fuente primaria del valor día; el D.S. 012-92-TR, art. 2, lo concreta
    en los divisores 30 (mes) y 15 (quincena). Se devuelve sin redondear para
    que cada consumidor aplique el redondeo una sola vez sobre el importe final.
    """
    return Decimal(monthly_salary) / LEGAL_MONTH_DAYS


def daily_value_out(monthly_salary: Decimal) -> Decimal:
    """Valor día legal listo para mostrar/transportar (4 decimales)."""
    return daily_value(monthly_salary).quantize(_RATE, rounding=ROUND_HALF_UP)


def days_value(monthly_salary: Decimal, days: int) -> Decimal:
    """Treintavos del valor día legal (periodo parcial: alta, cese o recorte)."""
    return (daily_value(monthly_salary) * Decimal(days)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def fortnight_halves(monthly_salary: Decimal) -> tuple[Decimal, Decimal]:
    """Reparte el sueldo mensual en Q1 y Q2 (CAL-04).

    La quincena entre 15 devuelve el mismo valor día que el mes entre 30, así
    que ambas mitades son consistentes con el art. 2 del D.S. 012-92-TR. El
    residuo de céntimos queda en Q2 para que Q1 + Q2 sea exactamente el sueldo.
    """
    first = (Decimal(monthly_salary) / Decimal(2)).quantize(_CENTS, rounding=ROUND_HALF_UP)
    return first, (Decimal(monthly_salary) - first).quantize(_CENTS, rounding=ROUND_HALF_UP)


def hourly_value(monthly_salary: Decimal, journey_minutes: int) -> Decimal:
    """Valor hora = valor día / horas de la jornada del trabajador (art. 12).

    La jornada es la del propio trabajador (puede ser menor a las 8 horas
    máximas). Sin jornada no hay valor hora calculable.
    """
    minutes = Decimal(journey_minutes)
    if minutes <= 0:
        return Decimal("0")
    return daily_value(monthly_salary) / (minutes / Decimal(60))


def hourly_value_out(monthly_salary: Decimal, journey_minutes: int) -> Decimal:
    """Valor hora listo para mostrar/transportar (4 decimales)."""
    return hourly_value(monthly_salary, journey_minutes).quantize(_RATE, rounding=ROUND_HALF_UP)


def double_days_value(monthly_salary: Decimal, known_minutes: int, reference_minutes: int) -> Decimal:
    """Descanso semanal o feriado trabajado: labor + sobretasa 100%.

    El pago ordinario del día ya está dentro del sueldo mensual, así que el
    adicional equivale a dos veces el valor de la labor efectuada, proporcional a
    los minutos netos realmente trabajados (D.L. 713, art. 3). La jornada de
    referencia solo fija el valor hora (valor día / horas de jornada); no topa
    las horas: toda hora neta trabajada en descanso o feriado se paga.
    """
    reference = Decimal(reference_minutes)
    if reference <= 0:
        return Decimal("0.00")
    labor = daily_value(monthly_salary) * Decimal(known_minutes) / reference
    return (labor + labor).quantize(_CENTS, rounding=ROUND_HALF_UP)
