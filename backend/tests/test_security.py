"""Tests de piezas de seguridad: Argon2, JWT y seed idempotente."""

from datetime import datetime, timedelta, timezone

import jwt as pyjwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings
from app.core.security import create_access_token, decode_access_token, hash_password, verify_password
from app.db.base import Base
from app.modules.system_roles.repository import SystemRoleRepository
from scripts.seed_roles import ROLES, seed


# --- Argon2 ---

def test_hash_y_verificacion_correcta():
    password_hash = hash_password("MiClaveSegura123!")
    assert password_hash != "MiClaveSegura123!"
    assert verify_password("MiClaveSegura123!", password_hash) is True


def test_verificacion_con_password_incorrecta():
    password_hash = hash_password("Correcta123!")
    assert verify_password("Incorrecta123!", password_hash) is False


def test_hash_distinto_para_misma_password():
    # Argon2 usa sal aleatoria: dos hashes del mismo valor no son iguales.
    assert hash_password("Igual123!") != hash_password("Igual123!")


def test_verificacion_con_hash_invalido_no_lanza():
    assert verify_password("cualquiera", "hash-que-no-es-argon2") is False


# --- JWT ---

def test_token_roundtrip():
    token = create_access_token("admin", "ADMIN")
    payload = decode_access_token(token)
    assert payload is not None
    assert payload["sub"] == "admin"
    assert payload["role"] == "ADMIN"


def test_token_expirado_es_rechazado():
    settings = get_settings()
    expired = pyjwt.encode(
        {"sub": "admin", "role": "ADMIN", "exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )
    assert decode_access_token(expired) is None


def test_token_con_firma_invalida_es_rechazado():
    forged = pyjwt.encode(
        {"sub": "admin", "role": "ADMIN", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        "otra-clave-para-el-test-abcdefghij123456",
        algorithm="HS256",
    )
    assert decode_access_token(forged) is None


# --- Seed idempotente ---

def test_seed_roles_idempotente():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        first = seed(session)
        second = seed(session)
        roles = SystemRoleRepository(session).list_all()
        assert first == len(ROLES)
        assert second == 0
        assert len(roles) == len(ROLES)
        names = {r.name for r in roles}
        assert names == {name for name, _ in ROLES}
    finally:
        session.close()
        Base.metadata.drop_all(engine)
