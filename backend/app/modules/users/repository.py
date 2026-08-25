"""Repositorio de usuarios del sistema."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.modules.system_roles.models import SystemRole
from app.modules.users.models import User


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_username(self, username: str) -> User | None:
        return self.db.scalar(select(User).where(User.username == username))

    def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return self.db.get(User, user_id)

    def get_by_id_detailed(self, user_id: uuid.UUID) -> User | None:
        return self.db.scalar(
            select(User)
            .options(joinedload(User.system_role), joinedload(User.employee))
            .where(User.id == user_id)
        )

    def list_all(self) -> list[User]:
        return list(
            self.db.scalars(
                select(User)
                .options(joinedload(User.system_role), joinedload(User.employee))
                .order_by(User.username)
            )
        )

    def create(
        self,
        *,
        username: str,
        password_hash: str,
        system_role_id: uuid.UUID,
        employee_id: uuid.UUID | None = None,
    ) -> User:
        user = User(
            username=username,
            password_hash=password_hash,
            system_role_id=system_role_id,
            employee_id=employee_id,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def set_last_login(self, user: User) -> None:
        user.last_login_at = datetime.now(timezone.utc)
        self.db.add(user)
        self.db.commit()

    def set_password_hash(self, user: User, password_hash: str) -> User:
        user.password_hash = password_hash
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def save(self, user: User) -> User:
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def count_active_admins_excluding(self, user_id: uuid.UUID) -> int:
        """ADMIN activos sin contar a `user_id` (guarda: mínimo 1 ADMIN)."""
        return int(
            self.db.scalar(
                select(func.count())
                .select_from(User)
                .join(SystemRole, User.system_role_id == SystemRole.id)
                .where(
                    User.active.is_(True),
                    SystemRole.name == "ADMIN",
                    User.id != user_id,
                )
            )
            or 0
        )

    def get_by_employee_id(self, employee_id: uuid.UUID) -> User | None:
        return self.db.scalar(select(User).where(User.employee_id == employee_id))
