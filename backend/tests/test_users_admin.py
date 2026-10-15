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
    """`password` queda solo para compatibilidad de llamadas antiguas de test.

    La API ya no lo recibe: devuelve una temporal de una sola respuesta.
    """
    payload = {"username": username, "system_role_id": role_id, **extra}
    response = client.post("/api/v1/users", json=payload)
    assert response.status_code == 201, response.text
    created = response.json()
    created["_temporary_password"] = created.pop("temporary_password")
    return created


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
            json={"username": "nuevo", "system_role_id": _admin_role_id(db_session)},
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
    response = client.post("/api/v1/auth/login", json={"username": "jefe2", "password": user["_temporary_password"]})
    assert response.status_code == 200
    assert response.json()["role"] == "BOSS"


def test_creacion_devuelve_temporal_solo_una_vez_y_nunca_en_listado(client, db_session):
    _login(client, "admin", "Admin123!")
    created = _create_user(client, "temporal_unico", "ignorada", _boss_role_id(db_session))
    assert len(created["_temporary_password"]) >= 8
    assert created["must_change_password"] is True
    listed = next(user for user in client.get("/api/v1/users").json() if user["id"] == created["id"])
    assert "temporary_password" not in listed
    assert "_temporary_password" not in listed


def test_password_en_payload_de_creacion_se_rechaza(client, db_session):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/users",
        json={"username": "sin_clave_manual", "password": "NoDebeEntrar1!", "system_role_id": _boss_role_id(db_session)},
    )
    assert response.status_code == 422


def test_crear_usuario_duplicado_409(client, db_session):
    _login(client, "admin", "Admin123!")
    _create_user(client, "dupe", "Contra123!", _boss_role_id(db_session))
    response = client.post(
        "/api/v1/users",
        json={"username": "dupe", "system_role_id": _boss_role_id(db_session)},
    )
    assert response.status_code == 409


def test_crear_usuario_con_rol_inexistente_422(client):
    _login(client, "admin", "Admin123!")
    response = client.post(
        "/api/v1/users",
        json={"username": "x", "system_role_id": str(uuid.uuid4())},
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
        client.post("/api/v1/auth/login", json={"username": "temporal", "password": user["_temporary_password"]}).status_code
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
    assert response.json()["must_change_password"] is True

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


def test_temporal_bloquea_operacion_hasta_cambio_y_luego_libera(client, db_session):
    _login(client, "admin", "Admin123!")
    created = _create_user(client, "pendiente", "ignorada", _boss_role_id(db_session))
    client.post("/api/v1/auth/logout")
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "pendiente", "password": created["_temporary_password"]},
    )
    assert login.status_code == 200
    assert login.json()["must_change_password"] is True
    assert client.get("/api/v1/auth/me").json()["must_change_password"] is True
    # Ruta administrativa directa, no solo la UI, queda bloqueada.
    blocked = client.get("/api/v1/employees")
    assert blocked.status_code == 403
    assert "contraseña temporal" in blocked.json()["detail"]
    assert (
        client.post(
            "/api/v1/auth/change-password",
            json={"current_password": created["_temporary_password"], "new_password": "NuevaSegura1!"},
        ).status_code
        == 204
    )
    assert client.get("/api/v1/employees").status_code == 200


def test_kiosco_publico_no_usa_la_guarda_de_clave_temporal(client):
    # Sin sesión y sin empleado coincidente: llega al flujo público (404), no
    # a la guarda administrativa 401/403.
    response = client.post("/api/v1/attendance/identify", json={"identifier": "EMP-INEXISTENTE"})
    assert response.status_code == 404


def test_cambio_temporal_con_actual_incorrecta_no_libera(client, db_session):
    _login(client, "admin", "Admin123!")
    created = _create_user(client, "pendiente_mala", "ignorada", _boss_role_id(db_session))
    client.post("/api/v1/auth/logout")
    _login(client, "pendiente_mala", created["_temporary_password"])
    assert client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "incorrecta", "new_password": "NuevaSegura1!"},
    ).status_code == 401
    assert client.get("/api/v1/employees").status_code == 403


def test_reset_reactiva_cambio_obligatorio_y_existentes_siguen_normales(client, db_session):
    _login(client, "boss", "Boss123!")
    assert client.get("/api/v1/auth/me").json()["must_change_password"] is False
    client.post("/api/v1/auth/logout")
    _login(client, "admin", "Admin123!")
    boss = next(item for item in client.get("/api/v1/users").json() if item["username"] == "boss")
    assert client.post(f"/api/v1/users/{boss['id']}/reset-password", json={"new_password": "TemporalNueva1!"}).status_code == 200
    client.post("/api/v1/auth/logout")
    _login(client, "boss", "TemporalNueva1!")
    assert client.get("/api/v1/auth/me").json()["must_change_password"] is True
    assert client.get("/api/v1/employees").status_code == 403


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
        assert "temporary_password" not in serialized
        assert "Nueva456!" not in serialized
        assert "Contra123!" not in serialized
