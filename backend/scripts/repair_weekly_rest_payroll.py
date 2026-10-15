"""Reparación auditada de referencia de descanso y refrigerio combinado.

Uso:
  uv run python -m scripts.repair_weekly_rest_payroll                 # dry-run
  uv run python -m scripts.repair_weekly_rest_payroll --apply \
      --actor-user-id <uuid> --reason "Corrección de referencia 480->300"

Por defecto es dry-run y no escribe nada.  ``--apply`` exige actor y motivo.
Los periodos CLOSED nunca se mutan: se reportan como pendientes de
``PayrollService.create_rectification``.
"""

import argparse
import json
import sys
import uuid

from app.modules.payroll.repair_service import PayrollRepairService


def _parse_date(value: str | None):
    if value is None:
        return None
    from datetime import date

    return date.fromisoformat(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Reparación de referencia de descanso y refrigerio")
    parser.add_argument("--apply", action="store_true", help="Aplica los cambios (por defecto sólo audita)")
    parser.add_argument("--actor-user-id", default=None, help="UUID del usuario que autoriza (obligatorio con --apply)")
    parser.add_argument("--reason", default=None, help="Motivo de la reparación (obligatorio con --apply)")
    parser.add_argument("--employee-id", default=None, help="Limita la reparación a un empleado")
    parser.add_argument("--date-from", default=None, help="Fecha ISO mínima")
    parser.add_argument("--date-to", default=None, help="Fecha ISO máxima")
    args = parser.parse_args()

    if args.apply and (not args.actor_user_id or not args.reason or not args.reason.strip()):
        raise SystemExit("ERROR: --apply exige --actor-user-id y --reason")

    from app.db.session import SessionLocal

    if SessionLocal is None:
        raise SystemExit("ERROR: DATABASE_URL no está configurado")
    db = SessionLocal()
    try:
        service = PayrollRepairService(db)
        employee_id = uuid.UUID(args.employee_id) if args.employee_id else None
        if args.apply:
            result = service.apply(
                actor_user_id=uuid.UUID(args.actor_user_id),
                reason=args.reason,
                employee_id=employee_id,
                date_from=_parse_date(args.date_from),
                date_to=_parse_date(args.date_to),
            )
        else:
            result = service.audit(
                employee_id=employee_id,
                date_from=_parse_date(args.date_from),
                date_to=_parse_date(args.date_to),
            )
        print(json.dumps(result, indent=2, default=str))
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
