"""Entorno Alembic del MVP.

La URL de conexión se toma de la configuración de la app (variable
``DATABASE_URL``), nunca se hardcodea en alembic.ini.
"""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

from app.core.config import get_settings
from app.db.base import Base
from app.db.session import engine_url

config = context.config

# La URL sale de la configuración central (.env / entorno).
# Migraciones SIEMPRE con conexión directa (sin -pooler): las pooled no
# soportan operaciones a nivel de sesión (ver skill neon-postgres).
settings = get_settings()
_migration_url = engine_url(settings.database_url_unpooled or settings.database_url)
if _migration_url:
    # Escapar % para evitar interpolación del .ini.
    config.set_main_option("sqlalchemy.url", _migration_url.replace("%", "%%"))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Los modelos se importan aquí en fases futuras para que autogenerate los vea.
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Modo offline: genera SQL sin conectar."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Modo online: aplica migraciones con una conexión real."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
