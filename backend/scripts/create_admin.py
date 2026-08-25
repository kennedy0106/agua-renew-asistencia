"""Crea el primer usuario ADMIN de forma segura.

La contraseña NUNCA vive en el repositorio: se pasa por flag o se pide por
prompt (getpass, sin eco).

Uso:
  uv run python -m scripts.create_admin --username admin --password 'MiClaveSegura!'
  uv run python -m scripts.create_admin --username admin   # pedirá la clave
"""

import argparse
import getpass
import sys

from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.repository import UserRepository

MIN_PASSWORD_LENGTH = 8


def create_admin(db: Session, *, username: str, password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"ERROR: la contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres")

    role = SystemRoleRepository(db).get_by_name("ADMIN")
    if role is None:
        raise SystemExit("ERROR: el rol ADMIN no existe — ejecuta primero: uv run python -m scripts.seed_roles")

    users = UserRepository(db)
    if users.get_by_username(username) is not None:
        raise SystemExit(f"ERROR: el usuario '{username}' ya existe")

    users.create(username=username, password_hash=hash_password(password), system_role_id=role.id)
    return username


def main() -> None:
    parser = argparse.ArgumentParser(description="Crea el primer usuario ADMIN")
    parser.add_argument("--username", required=True, help="Nombre de usuario del administrador")
    parser.add_argument("--password", default=None, help="Contraseña (si se omite, se pide por prompt)")
    args = parser.parse_args()

    password = args.password
    if password is None:
        password = getpass.getpass("Contraseña del administrador: ")

    from app.db.session import SessionLocal

    if SessionLocal is None:
        raise SystemExit("ERROR: DATABASE_URL no está configurado")
    db = SessionLocal()
    try:
        username = create_admin(db, username=args.username, password=password)
        print(f"Administrador '{username}' creado con rol ADMIN.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
