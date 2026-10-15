"""Servicio de administración de usuarios del sistema (Fase 13).

Guardas de seguridad:
- Un usuario no puede desactivarse a sí mismo.
- Debe quedar SIEMPRE al menos un ADMIN activo (no se puede desactivar ni
  quitar el rol al último).
- Username único; un empleado solo puede tener un usuario.
- Cambio de propia contraseña exige verificar la actual.
- Las acciones sensibles quedan auditadas (sin exponer contraseñas).
"""

import secrets
import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import hash_password, verify_password
from app.modules.audit.repository import AuditRepository
from app.modules.employees.repository import EmployeeRepository
from app.modules.system_roles.models import SystemRole
from app.modules.system_roles.repository import SystemRoleRepository
from app.modules.users.models import User
from app.modules.users.repository import UserRepository

_MISSING = object()


class UserAdminService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = UserRepository(db)

    def list_users(self) -> list[User]:
        return self.repo.list_all()

    def _get_or_404(self, user_id: uuid.UUID) -> User:
        user = self.repo.get_by_id(user_id)
        if user is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado")
        return user

    def _get_role_or_422(self, role_id: uuid.UUID) -> SystemRole:
        role = SystemRoleRepository(self.db).get_by_id(role_id)
        if role is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El rol del sistema no existe",
            )
        return role

    def _validate_employee(self, employee_id: uuid.UUID | None) -> None:
        if employee_id is None:
            return
        employee = EmployeeRepository(self.db).get_by_id(employee_id)
        if employee is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Empleado no encontrado"
            )
        linked = self.repo.get_by_employee_id(employee_id)
        if linked is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"El empleado ya tiene el usuario '{linked.username}'",
            )

    def create(
        self,
        *,
        username: str,
        system_role_id: uuid.UUID,
        employee_id: uuid.UUID | None,
        current_user_id: uuid.UUID,
    ) -> tuple[User, str]:
        username = username.strip()
        if self.repo.get_by_username(username) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="El nombre de usuario ya existe"
            )
        self._get_role_or_422(system_role_id)
        self._validate_employee(employee_id)

        # token_urlsafe usa CSPRNG del SO. La clave solo vive en memoria para
        # esta respuesta; el repositorio recibe exclusivamente el hash Argon2.
        temporary_password = secrets.token_urlsafe(18)
        user = self.repo.create(
            username=username,
            password_hash=hash_password(temporary_password),
            system_role_id=system_role_id,
            employee_id=employee_id,
            must_change_password=True,
        )
        AuditRepository(self.db).create(
            entity_type="user",
            entity_id=user.id,
            action="create",
            old_values=None,
            new_values={"username": user.username, "system_role_id": str(system_role_id)},
            reason=f"Creación del usuario {user.username}",
            performed_by=current_user_id,
        )
        return user, temporary_password

    def update(
        self,
        user_id: uuid.UUID,
        *,
        system_role_id: uuid.UUID | None,
        active: bool | None,
        employee_id,
        current_user_id: uuid.UUID,
    ) -> User:
        user = self._get_or_404(user_id)

        new_role = user.system_role_id
        if system_role_id is not None:
            role = self._get_role_or_422(system_role_id)
            new_role = role.id

        new_active = user.active if active is None else active
        is_admin_now = user.system_role.name == "ADMIN" if user.system_role else False
        new_role_is_admin = (
            SystemRoleRepository(self.db).get_by_id(new_role).name == "ADMIN"
            if new_role is not None
            else False
        )

        # Guarda 1: no auto-desactivarse.
        if active is False and user.id == current_user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No puedes desactivar tu propio usuario",
            )
        # Guarda 2: mínimo un ADMIN activo.
        losing_admin = is_admin_now and (not new_active or not new_role_is_admin)
        if losing_admin and self.repo.count_active_admins_excluding(user.id) == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Debe quedar al menos un ADMIN activo en el sistema",
            )

        # Guarda 3: vínculo de empleado.
        if employee_id is not _MISSING:
            if employee_id is None:
                user.employee_id = None
            else:
                self._validate_employee(employee_id)
                user.employee_id = employee_id

        old = {
            "active": user.active,
            "system_role_id": str(user.system_role_id),
            "employee_id": str(user.employee_id) if user.employee_id else None,
        }
        if system_role_id is not None:
            user.system_role_id = system_role_id
        if active is not None:
            user.active = active
        saved = self.repo.save(user)

        new = {
            "active": saved.active,
            "system_role_id": str(saved.system_role_id),
            "employee_id": str(saved.employee_id) if saved.employee_id else None,
        }
        AuditRepository(self.db).create(
            entity_type="user",
            entity_id=user_id,
            action="update",
            old_values=old,
            new_values=new,
            reason="Actualización de usuario (rol/estado/vínculo)",
            performed_by=current_user_id,
        )
        return saved

    def reset_password(self, user_id: uuid.UUID, *, new_password: str, current_user_id: uuid.UUID) -> User:
        user = self._get_or_404(user_id)
        saved = self.repo.set_password(user, hash_password(new_password), must_change_password=True)
        AuditRepository(self.db).create(
            entity_type="user",
            entity_id=user_id,
            action="reset_password",
            old_values={"username": user.username},
            new_values={"username": user.username},
            reason=f"Restablecimiento de contraseña por un administrador",
            performed_by=current_user_id,
        )
        return saved

    def change_own_password(self, user: User, *, current_password: str, new_password: str) -> None:
        if not verify_password(current_password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="La contraseña actual es incorrecta",
            )
        self.repo.set_password(user, hash_password(new_password), must_change_password=False)
        AuditRepository(self.db).create(
            entity_type="user",
            entity_id=user.id,
            action="change_password",
            old_values={"username": user.username},
            new_values={"username": user.username},
            reason="Cambio de contraseña por el propio usuario",
            performed_by=user.id,
        )
