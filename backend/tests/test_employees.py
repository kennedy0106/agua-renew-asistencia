"""Tests de empleados: permisos (ADMIN y BOSS crean), validaciones y desactivación."""

import uuid


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _payload(job_role_id, **overrides):
    base = {
        "dni": "72845632",
        "employee_code": "EMP-001",
        "first_name": "Juan",
        "last_name": "Pérez",
        "job_role_id": str(job_role_id),
    }
    base.update(overrides)
    return base


def _create(client, payload):
    return client.post("/api/v1/employees", json=payload)


# --- Permisos (decisión de negocio: ADMIN y BOSS pueden crear) ---

def test_create_como_admin(client, db_session):
    _login(client, "admin", "Admin123!")
    response = _create(client, _payload(db_session._test_job_roles["Operario"]))
    assert response.status_code == 201
    body = response.json()
    assert body["dni"] == "72845632"
    assert body["job_role_name"] == "Operario"
    assert body["active"] is True


def test_create_como_boss_permitido(client, db_session):
    """Recordatorio del usuario: los jefes (BOSS) también crean empleados."""
    _login(client, "boss", "Boss123!")
    response = _create(client, _payload(db_session._test_job_roles["Chofer"]))
    assert response.status_code == 201
    assert response.json()["employee_code"] == "EMP-001"


def test_create_como_supervisor_forbidden(client, db_session):
    _login(client, "supervisor", "Sup123!")
    response = _create(client, _payload(db_session._test_job_roles["Operario"]))
    assert response.status_code == 403


def test_create_sin_autenticacion(client, db_session):
    assert _create(client, _payload(db_session._test_job_roles["Operario"])).status_code == 401


def test_list_requiere_autenticacion(client):
    assert client.get("/api/v1/employees").status_code == 401


def test_list_como_supervisor_permitido(client):
    _login(client, "supervisor", "Sup123!")
    assert client.get("/api/v1/employees").status_code == 200


# --- Validaciones ---

def test_dni_invalido_rechazado(client, db_session):
    _login(client, "admin", "Admin123!")
    for bad_dni in ("12345", "123456789", "abcdefgh", "1234567a"):
        response = _create(client, _payload(db_session._test_job_roles["Operario"], dni=bad_dni))
        assert response.status_code == 422, f"DNI {bad_dni} debió ser rechazado"


def test_dni_duplicado_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    assert _create(client, _payload(role_id)).status_code == 201
    response = _create(client, _payload(role_id, employee_code="EMP-002"))
    assert response.status_code == 409


def test_codigo_duplicado_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    assert _create(client, _payload(role_id)).status_code == 201
    response = _create(client, _payload(role_id, dni="99999999"))
    assert response.status_code == 409


def test_cargo_inexistente_rechazado(client):
    _login(client, "admin", "Admin123!")
    response = _create(client, _payload(uuid.uuid4()))
    assert response.status_code == 422


def test_nombres_vacios_rechazados(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    response = _create(client, _payload(role_id, first_name="   "))
    assert response.status_code == 422


# --- Lectura y detalle ---

def test_get_detalle_con_cargo(client, db_session):
    _login(client, "boss", "Boss123!")
    created = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    response = client.get(f"/api/v1/employees/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["first_name"] == "Juan"
    assert body["job_role_name"] == "Operario"


def test_get_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    assert client.get(f"/api/v1/employees/{uuid.uuid4()}").status_code == 404


# --- Edición y desactivación ---

def test_patch_editar_y_cambiar_cargo(client, db_session):
    _login(client, "boss", "Boss123!")
    created = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    response = client.patch(
        f"/api/v1/employees/{created['id']}",
        json={"first_name": "Juan Carlos", "job_role_id": str(db_session._test_job_roles["Chofer"])},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["first_name"] == "Juan Carlos"
    assert body["job_role_name"] == "Chofer"


def test_patch_dni_duplicado_conflict(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    first = _create(client, _payload(role_id)).json()
    _create(client, _payload(role_id, dni="99999999", employee_code="EMP-002"))
    response = client.patch(f"/api/v1/employees/{first['id']}", json={"dni": "99999999"})
    assert response.status_code == 409


def test_deactivate_conserva_historial(client, db_session):
    _login(client, "boss", "Boss123!")
    created = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    response = client.post(f"/api/v1/employees/{created['id']}/deactivate")
    assert response.status_code == 200
    assert response.json()["active"] is False

    # Sigue apareciendo en el listado (inactivo), no se borra.
    listing = client.get("/api/v1/employees").json()
    assert any(e["id"] == created["id"] and e["active"] is False for e in listing)


def test_reactivate_empleado(client, db_session):
    """F1: un empleado cesado puede reactivarse sin perder historial."""
    _login(client, "admin", "Admin123!")
    created = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    client.post(f"/api/v1/employees/{created['id']}/deactivate")

    response = client.post(f"/api/v1/employees/{created['id']}/activate")
    assert response.status_code == 200
    assert response.json()["active"] is True


def test_reactivate_requiere_admin_o_boss(client, db_session):
    _login(client, "admin", "Admin123!")
    created = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    _login(client, "supervisor", "Sup123!")
    response = client.post(f"/api/v1/employees/{created['id']}/activate")
    assert response.status_code == 403


def test_patch_como_supervisor_forbidden(client, db_session):
    _login(client, "supervisor", "Sup123!")
    response = client.patch(f"/api/v1/employees/{uuid.uuid4()}", json={"first_name": "X"})
    assert response.status_code == 403


# --- Filtros ---

def test_filtro_por_estado_y_busqueda(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    emp1 = _create(client, _payload(role_id)).json()
    _create(client, _payload(role_id, dni="99999999", employee_code="EMP-002", first_name="Ana"))
    client.post(f"/api/v1/employees/{emp1['id']}/deactivate")

    active_only = client.get("/api/v1/employees?active=true").json()
    assert all(e["active"] for e in active_only)
    assert len(active_only) == 1

    search = client.get("/api/v1/employees?search=ana").json()
    assert len(search) == 1


# --- QR único por empleado (Fase 19) ---

def test_empleado_tiene_qr_token_unico(client, db_session):
    _login(client, "admin", "Admin123!")
    role_id = db_session._test_job_roles["Operario"]
    emp1 = _create(client, _payload(role_id)).json()
    emp2 = _create(client, _payload(role_id, dni="99999999", employee_code="EMP-002")).json()

    assert emp1["qr_token"]
    assert emp2["qr_token"]
    assert emp1["qr_token"] != emp2["qr_token"]
    # token aleatorio (no el código interno, que es predecible)
    assert emp1["qr_token"] != emp1["employee_code"]


def test_qr_endpoint_devuelve_svg(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create(client, _payload(db_session._test_job_roles["Operario"])).json()

    response = client.get(f"/api/v1/employees/{emp['id']}/qr")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/svg+xml"
    # Es un SVG válido (el token va codificado en los paths, no en texto plano).
    assert response.text.lstrip().startswith("<?xml") or "<svg" in response.text
    assert "<path" in response.text


def test_qr_endpoint_requiere_auth(client):
    response = client.get(f"/api/v1/employees/{uuid.uuid4()}/qr")
    assert response.status_code == 401


def test_rotar_qr_cambia_token(client, db_session):
    _login(client, "admin", "Admin123!")
    emp = _create(client, _payload(db_session._test_job_roles["Operario"])).json()
    rotated = client.post(f"/api/v1/employees/{emp['id']}/qr/rotate")
    assert rotated.status_code == 200
    assert rotated.json()["qr_token"] != emp["qr_token"]
