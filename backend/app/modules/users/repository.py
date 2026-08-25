"""Repositorio de usuarios del sistema."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.users.models import User


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_username(self, username: str) -> User | None:
        return self.db.scalar(select(User).where(User.username == username))

    def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return self.db.get(User, user_id)

    def create(self, *, username: str, password_hash: str, system_role_id: uuid.UUID) -> User:
        user = User(username=username, password_hash=password_hash, system_role_id=system_role_id)
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def set_last_login(self, user: User) -> None:
        user.last_login_at = datetime.now(timezone.utc)
        self.db.add(user)
        self.db.commit()
