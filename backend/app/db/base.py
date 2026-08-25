"""Base declarativa de SQLAlchemy.

Los modelos de cada módulo (employees, attendance, payroll, ...) heredarán
de ``Base``. Alembic usará ``Base.metadata`` como fuente de verdad del esquema.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base única del MVP. Fase 0: aún sin modelos."""
