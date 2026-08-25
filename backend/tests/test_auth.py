"""Tests de autenticación: login, sesión en cookie, logout y permisos por rol."""

from datetime import datetime, timedelta, timezone

import jwt as pyjwt

from app.core.config import get_settings
from app.core.security import hash_password


def _login(client, username: str, password: str):
    return client.post("/api/v1/auth/login", json={"username": username, "password": password})


def _cookie_name() -> str:
    return get_settings().session_cookie_name


# --- Login ---

def test_login_ok_establece_cookie(client):
    response = _login(client, "admin", "Admin123!")
    assert response.status_code == 200
    body = response.json()
    assert body["username"] == "admin"
    assert body["role"] == "ADMIN"
    assert "password_hash" not in body
    set_cookie = response.headers.get("set-cookie", "")
    assert _cookie_name() in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie


def test_login_contraseña_incorrecta(client):
    response = _login(client, "admin", "clave-mala")
    assert response.status_code == 401


def test_login_usuario_inexistente(client):
    response = _login(client, "nadie", "Admin123!")
    assert response.status_code == 401


def test_login_usuario_inactivo(client):
    response = _login(client, "inactive", "Ina123!")
    assert response.status_code == 401


def test_login_campos_vacios(client):
    assert client.post("/api/v1/auth/login", json={"username": "", "password": ""}).status_code == 422


# --- /me ---

def test_me_sin_cookie_401(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_con_sesion_valida(client):
    _login(client, "boss", "Boss123!")
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 200
    body = response.json()
    assert body["username"] == "boss"
    assert body["role"] == "BOSS"


def test_me_con_token_expirado(client):
    settings = get_settings()
    expired = pyjwt.encode(
        {
            "sub": "admin",
            "role": "ADMIN",
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
        },
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )
    client.cookies.set(_cookie_name(), expired)
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_con_token_falsificado(client):
    forged = pyjwt.encode(
        {"sub": "admin", "role": "ADMIN", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        "clave-equivocada-para-el-test-1234567890!",
        algorithm="HS256",
    )
    client.cookies.set(_cookie_name(), forged)
    assert client.get("/api/v1/auth/me").status_code == 401


# --- Logout ---

def test_logout_limpia_cookie(client):
    _login(client, "admin", "Admin123!")
    assert client.get("/api/v1/auth/me").status_code == 200

    response = client.post("/api/v1/auth/logout")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert client.get("/api/v1/auth/me").status_code == 401


# --- Permisos por rol ---

def test_admin_accede_a_ruta_solo_admin(client):
    _login(client, "admin", "Admin123!")
    response = client.get("/test/admin-only")
    assert response.status_code == 200
    assert response.json()["username"] == "admin"


def test_boss_bloqueado_de_ruta_solo_admin(client):
    _login(client, "boss", "Boss123!")
    response = client.get("/test/admin-only")
    assert response.status_code == 403


def test_boss_accede_a_ruta_admin_o_boss(client):
    _login(client, "boss", "Boss123!")
    assert client.get("/test/boss-or-admin").status_code == 200


def test_supervisor_bloqueado_de_ruta_admin_o_boss(client):
    _login(client, "supervisor", "Sup123!")
    assert client.get("/test/boss-or-admin").status_code == 403


def test_sin_autenticacion_bloqueado(client):
    assert client.get("/test/admin-only").status_code == 401
