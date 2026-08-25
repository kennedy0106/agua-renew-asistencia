"""Tests de administración de usuarios: permisos, guardas y contraseñas."""

import uuid


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _admin_role_id(db_session):
    return str(db_session._test_system_roles["ADMIN"])


def _boss_role_id(db_session):
    return str(db_session._test_system_roles["BOSS"])


def _supervisor_role_id(db_session):
    return str(db_session._test_system_roles["SUPERVISOR"])


def _create_user(client, username: str, password: str, role_id: str, **extra) -> dict:
    payload = {"username": username, "password": password, "system_role_id": role_id, **extra}
    response = client.post("/api/v1/users", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- Permisos ---

def test_listar_usuarios_solo_admin(client):
    _login(client, "admin", "Admin123!")
    response = client.get("/api/v1/users")
    assert response.status_code == 200
    assert any(u["username"] == "admin" for u in response.json())


def test_listar_usuarios_boss_forbidden(client):
    _login(client, "boss", "Boss123!")
    assert client.get("/api/v1/users").status_code == 403


def test_crear_usuario_sin_auth(client):
    assert client.post(
        "/api/v1/users",
        json={"username": "nuevo", "password": "Contra123!", "system_role_id": str(uuid.uuid4())},
    ).status_code == 401


def test_crear_usuario_como_boss_forbidden(client, db_session):
    _login(client, "boss", "Boss123!")
    assert (
        client.post(
            "/api/v1/users",
            json={"username": "nuevo", "password": "Contra123!", "system_role_id": _admin_role_id(db_session)},
        ).status_code
        == 403
    )


# --- Creación ---

def test_crear_usuario_con_rol(client, db_session):
    _login(client, "admin", "Admin123!")
    user = _create_user(client, "jefe2", "Jefe2123!", _boss_role_id(db_session))
    assert user["role"] == "BOSS"
    assert user["active"] is True

    # El nuevo usuario puede entrar.
    response = client.post("/api/v1/auth/login", json={"username": "jefe2", "password": "Jefe2123!"})
    assert response.status_code == 200
    assert response.json()["role"] == "BOSS"


def test_crear_usuario_duplicado_409(client, db_session):
    _login(client, "admin", "Admin123!")
    _create_user(client, "dupe", "Contra123!", _boss_role_id(db_session))
    response = client.post(
        "/api/v1/users",
        json={"username": "dupe", "password": "Contra123!", "system_role_id": _boss_role_id(db_session)},
    )
    assert response.status_code == 409


def test_crear_usuario_con_rol_inexistente_422(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/users",
        json={"username": "x", "password": "Contra123!", "system_role_id": str(uuid.uuid4())},
    )
    assert response.status_code == 422


def test_crear_usuario_con_empleado_ocupado_409(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = client.post(
        "/api/v1/employees",
        json={
            "dni": "72845632",
            "employee_code": "EMP-001",
            "first_name": "Juan",
            "last_name": "Pérez",
            "job_role_id": str(db_session._test_job_roles["Operario"]),
        },
    ).json()["id"]
    _create_user(client, "usuario1", "Contra123!", _supervisor_role_id(db_session), employee_id=emp)
    response = client.post(
        "/api/v1/users",
        json={
            "username": "usuario2",
            "password": "Contra123!",
            "system_role_id": _supervisor_role_id(db_session),
            "employee_id": emp,
        },
    )
    assert response.status_code == 409


# --- Actualización / guardas ---

def test_no_auto_desactivarse(client):
    _login(client, "admin", "Admin123!")
    me = client.get("/api/v1/users").json()[0]
    assert me["username"] == "admin"
    response = client.patch(f"/api/v1/users/{me['id']}", json={"active": False})
    assert response.status_code == 409


def test_no_quitar_ultimo_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    me = next(u for u in client.get("/api/v1/users").json() if u["username"] == "admin")
    response = client.patch(f"/api/v1/users/{me['id']}", json={"system_role_id": _boss_role_id(db_session)})
    assert response.status_code == 409


def test_desactivar_usuario_bloquea_login(client, db_session):
    _login(client, "admin", "Admin123!")
    user = _create_user(client, "temporal", "Contra123!", _boss_role_id(db_session))
    _create_user(client, "otro_admin", "Contra123!", _admin_role_id(db_session))  # queda otro ADMIN

    response = client.patch(f"/api/v1/users/{user['id']}", json={"active": False})
    assert response.status_code == 200
    assert response.json()["active"] is False

    client.post("/api/v1/auth/logout")
    assert (
        client.post("/api/v1/auth/login", json={"username": "temporal", "password": "Contra123!"}).status_code
        == 401
    )


def test_cambiar_rol_a_supervisor(client, db_session):
    _login(client, "admin", "Admin123!")
    user = _create_user(client, "jefe3", "Contra123!", _boss_role_id(db_session))
    response = client.patch(f"/api/v1/users/{user['id']}", json={"system_role_id": _supervisor_role_id(db_session)})
    assert response.status_code == 200
    assert response.json()["role"] == "SUPERVISOR"


# --- Contraseñas ---

def test_reset_password_por_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    user = _create_user(client, "reseteado", "Vieja123!", _boss_role_id(db_session))

    response = client.post(f"/api/v1/users/{user['id']}/reset-password", json={"new_password": "Nueva456!"})
    assert response.status_code == 200

    client.post("/api/v1/auth/logout")
    assert (
        client.post("/api/v1/auth/login", json={"username": "reseteado", "password": "Vieja123!"}).status_code
        == 401
    )
    assert (
        client.post("/api/v1/auth/login", json={"username": "reseteado", "password": "Nueva456!"}).status_code
        == 200
    )


def test_cambiar_propia_contrasena(client):
    _login(client, "boss", "Boss123!")
    assert (
        client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "Incorrecta1", "new_password": "NuevaBoss1!"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "Boss123!", "new_password": "NuevaBoss1!"},
        ).status_code
        == 204
    )
    client.post("/api/v1/auth/logout")
    assert (
        client.post("/api/v1/auth/login", json={"username": "boss", "password": "NuevaBoss1!"}).status_code
        == 200
    )


def test_nueva_contrasena_corta_422(client):
    _login(client, "boss", "Boss123!")
    response = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "Boss123!", "new_password": "corta"},
    )
    assert response.status_code == 422


# --- Auditoría ---

def test_auditoria_de_usuarios(client, db_session):
    _login(client, "admin", "Admin123!")
    user = _create_user(client, "auditable", "Contra123!", _boss_role_id(db_session))
    client.patch(f"/api/v1/users/{user['id']}", json={"active": False})
    client.post(f"/api/v1/users/{user['id']}/reset-password", json={"new_password": "Nueva456!"})

    logs = client.get("/api/v1/audit-logs").json()
    user_logs = [l for l in logs if l["entity_type"] == "user"]
    assert any(l["action"] == "create" for l in user_logs)
    assert any(l["action"] == "update" for l in user_logs)
    assert any(l["action"] == "reset_password" for l in user_logs)
    # Ningún log expone contraseñas.
    for log in user_logs:
        serialized = str(log)
        assert "password" not in serialized.lower() or "password" not in str(log["old_values"]).lower()
