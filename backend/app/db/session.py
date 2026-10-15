"""Motor, fábrica de sesiones y dependencia de BD.

Sin ``DATABASE_URL`` configurado el motor es ``None``: la app arranca igual
(los endpoints que necesiten BD devuelven un error claro). Nunca se asume
una conexión eterna: ``pool_pre_ping`` valida antes de cada uso.
"""

from collections.abc import Generator

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.request_timing import collector_from_request

_settings = get_settings()


def engine_url(url: str) -> str:
    """Normaliza una URL postgres para usar el dialecto psycopg (v3) de SQLAlchemy.

    Las URLs de Neon llegan como ``postgresql://``, que SQLAlchemy asocia por
    defecto a psycopg2; el proyecto usa psycopg 3 (``postgresql+psycopg://``).
    """
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


engine = (
    create_engine(engine_url(_settings.database_url), pool_pre_ping=True, future=True)
    if _settings.database_url
    else None
)

SessionLocal = (
    sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    if engine is not None
    else None
)


def get_db(request: Request) -> Generator[Session, None, None]:
    """Dependencia FastAPI: entrega una sesión y la cierra al terminar.

    Instrumentación opt-in: solo con un acumulador en el estado de la petición
    (ruta objetivo y flag activo) se fuerza la adquisición explícita de la
    conexión y se miden sus cursores. La adquisición es explícita aquí porque
    ``pool_pre_ping`` y el setup del checkout ocurren dentro de
    ``Session.connection()``, no en la primera consulta diferida.
    """
    if SessionLocal is None:
        raise RuntimeError("DATABASE_URL no está configurado")
    collector = collector_from_request(request)
    db = SessionLocal()
    try:
        if collector is not None:
            started = collector.begin_acquisition()
            try:
                connection = db.connection()
            finally:
                collector.finish_acquisition(started)
            collector.attach(connection)
        yield db
    finally:
        try:
            if collector is not None:
                # Retirar listeners antes de devolver la conexión al pool.
                collector.detach()
        finally:
            # Cerrar siempre, incluso si ``detach`` fallara.
            db.close()
