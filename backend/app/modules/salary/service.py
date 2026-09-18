"""Servicio de configuración salarial.

- El sueldo se guarda con vigencia: cambiar S/1300 → S/1500 crea una nueva
  configuración y cierra la anterior (el historial no se altera).
- Horas extra por tramos (seccion_horas_extra.md): las tasas se resuelven vía
  política general o override por empleado. Aquí solo se configuran los datos
  del override (si use_custom_overtime_rates).
- La tarifa por hora se deriva internamente (payroll); nunca se ingresa.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.modules.audit.repository import AuditRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.salary.models import SalarySetting
from app.modules.salary.repository import SalarySettingRepository


class SalaryService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = SalarySettingRepository(db)

    def get_current(self, employee_id: uuid.UUID) -> SalarySetting:
        setting = self.repo.get_active(employee_id)
        if setting is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="El empleado no tiene sueldo configurado",
            )
        return setting

    def get_for_date(self, employee_id: uuid.UUID, day: date) -> SalarySetting | None:
        return self.repo.get_for_date(employee_id, day)

    def get_for_days(
        self, employee_days: dict[uuid.UUID, Iterable[date]]
    ) -> dict[tuple[uuid.UUID, date], SalarySetting | None]:
        """Configuración salarial vigente por empleado/día con una sola consulta."""
        normalized = {
            employee_id: sorted(set(days))
            for employee_id, days in employee_days.items()
            if days
        }
        if not normalized:
            return {}
        all_days = [day for days in normalized.values() for day in days]
        history_by_employee: dict[uuid.UUID, list[SalarySetting]] = defaultdict(list)
        for setting in self.repo.list_overlapping(normalized.keys(), min(all_days), max(all_days)):
            history_by_employee[setting.employee_id].append(setting)
        result: dict[tuple[uuid.UUID, date], SalarySetting | None] = {}
        for employee_id, days in normalized.items():
            history = history_by_employee.get(employee_id, [])
            for day in days:
                result[(employee_id, day)] = next(
                    (
                        item
                        for item in reversed(history)
                        if item.effective_from <= day
                        and (item.effective_to is None or item.effective_to >= day)
                    ),
                    None,
                )
        return result

    def get_for_date_or_404(self, employee_id: uuid.UUID, day: date) -> SalarySetting:
        setting = self.repo.get_for_date(employee_id, day)
        if setting is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No hay sueldo configurado para esa fecha",
            )
        return setting

    def list_history(self, employee_id: uuid.UUID) -> list[SalarySetting]:
        return self.repo.list_history(employee_id)

    def set_salary(
        self,
        *,
        employee_id: uuid.UUID,
        monthly_salary: Decimal,
        effective_from: date,
        overtime_enabled: bool = False,
        use_custom_overtime_rates: bool = False,
        custom_first_two_hours_rate: Decimal | None = None,
        custom_additional_hours_rate: Decimal | None = None,
        performed_by: uuid.UUID | None = None,
    ) -> SalarySetting:
        if EmployeeRepository(self.db).get_by_id(employee_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")

        active = self.repo.get_active(employee_id)
        if active is not None and active.effective_from >= effective_from:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Ya hay un sueldo vigente desde {active.effective_from.isoformat()}. "
                    "Para cambiarlo, usa una fecha posterior (la nueva configuración "
                    "entrará en vigor ese día y la anterior quedará en el historial)."
                ),
            )

        self._validate_custom_rates(
            use_custom_overtime_rates=use_custom_overtime_rates,
            custom_first_two_hours_rate=custom_first_two_hours_rate,
            custom_additional_hours_rate=custom_additional_hours_rate,
        )

        if active is not None:
            self.repo.close_active(employee_id, effective_from - timedelta(days=1))

        created = self.repo.create(
            employee_id=employee_id,
            monthly_salary=monthly_salary,
            effective_from=effective_from,
            overtime_enabled=overtime_enabled,
            use_custom_overtime_rates=use_custom_overtime_rates,
            custom_first_two_hours_rate=custom_first_two_hours_rate,
            custom_additional_hours_rate=custom_additional_hours_rate,
        )

        # Importación local para no crear un ciclo de módulos al registrar
        # modelos. La configuración cambia previews, nunca snapshots cerrados.
        from app.modules.work_calendar.service import WorkCalendarService
        WorkCalendarService(self.db).invalidate_dependent_valuations(employee_id, effective_from)

        AuditRepository(self.db).create(
            entity_type="salary",
            entity_id=created.id,
            action="set_salary",
            old_values=self._serialize(active),
            new_values=self._serialize(created),
            reason=f"Nuevo sueldo vigente desde {effective_from.isoformat()}",
            performed_by=performed_by,
        )
        return created

    @staticmethod
    def _serialize(setting: SalarySetting | None) -> dict | None:
        if setting is None:
            return None
        return {
            "monthly_salary": str(setting.monthly_salary),
            "overtime_enabled": setting.overtime_enabled,
            "use_custom_overtime_rates": setting.use_custom_overtime_rates,
            "custom_first_two_hours_rate": str(setting.custom_first_two_hours_rate)
            if setting.custom_first_two_hours_rate is not None
            else None,
            "custom_additional_hours_rate": str(setting.custom_additional_hours_rate)
            if setting.custom_additional_hours_rate is not None
            else None,
            "effective_from": setting.effective_from.isoformat(),
            "effective_to": setting.effective_to.isoformat() if setting.effective_to else None,
        }

    @staticmethod
    def _validate_custom_rates(
        *,
        use_custom_overtime_rates: bool,
        custom_first_two_hours_rate: Decimal | None,
        custom_additional_hours_rate: Decimal | None,
    ) -> None:
        if not use_custom_overtime_rates:
            return
        if custom_first_two_hours_rate is None or custom_additional_hours_rate is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="use_custom_overtime_rates requiere ambas tasas personalizadas",
            )
        if custom_first_two_hours_rate < Decimal("25"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="custom_first_two_hours_rate no puede ser menor al 25%",
            )
        if custom_additional_hours_rate < Decimal("35"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="custom_additional_hours_rate no puede ser menor al 35%",
            )
