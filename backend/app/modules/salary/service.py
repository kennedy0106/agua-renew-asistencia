"""Servicio de configuración salarial.

- El sueldo se guarda con vigencia: cambiar S/1300 → S/1500 crea una nueva
  configuración y cierra la anterior (el historial no se altera).
- Validación cruzada de horas extra: PERCENTAGE exige overtime_percentage;
  FIXED_RATE exige overtime_fixed_rate.
- La tarifa por hora se deriva internamente (Fase 11, payroll); nunca se
  ingresa como dato principal.
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

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
        overtime_method: str = "PERCENTAGE",
        overtime_percentage: Decimal | None = None,
        overtime_fixed_rate: Decimal | None = None,
    ) -> SalarySetting:
        if EmployeeRepository(self.db).get_by_id(employee_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado")

        active = self.repo.get_active(employee_id)
        if active is not None and active.effective_from >= effective_from:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ya existe una configuración vigente desde esa fecha o después; elige una fecha posterior",
            )

        self._validate_overtime(
            overtime_enabled=overtime_enabled,
            overtime_method=overtime_method,
            overtime_percentage=overtime_percentage,
            overtime_fixed_rate=overtime_fixed_rate,
        )

        if active is not None:
            self.repo.close_active(employee_id, effective_from - timedelta(days=1))

        return self.repo.create(
            employee_id=employee_id,
            monthly_salary=monthly_salary,
            effective_from=effective_from,
            overtime_enabled=overtime_enabled,
            overtime_method=overtime_method,
            overtime_percentage=overtime_percentage,
            overtime_fixed_rate=overtime_fixed_rate,
        )

    @staticmethod
    def _validate_overtime(*, overtime_enabled: bool, overtime_method: str, overtime_percentage: Decimal | None, overtime_fixed_rate: Decimal | None) -> None:
        if not overtime_enabled:
            return
        if overtime_method == "PERCENTAGE" and overtime_percentage is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El método PERCENTAGE requiere overtime_percentage",
            )
        if overtime_method == "FIXED_RATE" and overtime_fixed_rate is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El método FIXED_RATE requiere overtime_fixed_rate",
            )
