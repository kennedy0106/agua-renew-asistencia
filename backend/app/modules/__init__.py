"""Módulos de negocio (cada uno con modelos, schemas, repos y servicios).

Este __init__ registra TODOS los modelos: como Python ejecuta el __init__
del paquete antes de importar cualquier submódulo, las relaciones por nombre
(relationship("User"), etc.) resuelven sin importar en cada script.
"""

from app.modules.attendance.models import AttendanceRecord  # noqa: F401
from app.modules.audit.models import AuditLog  # noqa: F401
from app.modules.employees.models import Employee  # noqa: F401
from app.modules.job_roles.models import JobRole  # noqa: F401
from app.modules.salary.models import SalarySetting  # noqa: F401
from app.modules.schedules.models import WorkSchedule  # noqa: F401
from app.modules.system_roles.models import SystemRole  # noqa: F401
from app.modules.users.models import User  # noqa: F401
