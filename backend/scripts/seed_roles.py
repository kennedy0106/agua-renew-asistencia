"""Seed idempotente de roles del sistema.

Uso:  uv run python -m scripts.seed_roles

Puede ejecutarse varias veces: no duplica registros.
"""

from sqlalchemy.orm import Session

from app.modules.system_roles.repository import SystemRoleRepository

ROLES: list[tuple[str, str]] = [
    ("ADMIN", "Acceso completo: empleados, asistencia, sueldos, usuarios, roles y auditoría"),
    ("BOSS", "Gestión operativa: empleados, asistencia, permisos, recuperación, horas extra y sueldos"),
    ("SUPERVISOR", "Consulta de empleados y asistencia, incidencias y observaciones; sin acceso salarial"),
]


def seed(db: Session) -> int:
    """Inserta los roles que falten. Devuelve cuántos creó."""
    repo = SystemRoleRepository(db)
    created = 0
    for name, description in ROLES:
        if repo.get_by_name(name) is None:
            repo.create(name=name, description=description)
            created += 1
    return created


def main() -> None:
    from app.db.session import SessionLocal

    if SessionLocal is None:
        raise SystemExit("ERROR: DATABASE_URL no está configurado")
    db = SessionLocal()
    try:
        created = seed(db)
        print(f"Seed de roles completado: {created} creado(s), {len(ROLES)} totales.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
