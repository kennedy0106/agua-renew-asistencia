"""Base declarativa de SQLAlchemy.

Los modelos de cada módulo (employees, attendance, payroll, ...) heredarán
de ``Base``. Alembic usará ``Base.metadata`` como fuente de verdad del esquema.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base única del MVP.

    Los modelos se registran en ``app.modules`` (ver su __init__.py);
    aquí NO se importan para evitar ciclos de importación.
    """
