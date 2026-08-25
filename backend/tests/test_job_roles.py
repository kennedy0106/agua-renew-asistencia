"""Tests de cargos laborales: permisos, duplicados activos y desactivación."""

import uuid


def _login(client, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _create(client, name: str, description: str | None = None):
    return client.post(
        "/api/v1/job-roles", json={"name": name, "description": description}
    )


# --- Lectura ---

def test_list_requiere_autenticacion(client):
    assert client.get("/api/v1/job-roles").status_code == 401


def test_list_con_rol_autenticado(client):
    _login(client, "supervisor", "Sup123!")
    response = client.get("/api/v1/job-roles")
    assert response.status_code == 200
    assert response.json() == []


# --- Creación ---

def test_create_como_admin(client):
    _login(client, "admin", "Admin123!")
    response = _create(client, "Operario", "Línea de producción")
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Operario"
    assert body["active"] is True
    assert body["description"] == "Línea de producción"


def test_create_como_boss_forbidden(client):
    _login(client, "boss", "Boss123!")
    assert _create(client, "Chofer").status_code == 403


def test_create_sin_autenticacion(client):
    assert _create(client, "Chofer").status_code == 401


def test_create_nombre_vacio_rechazado(client):
    _login(client, "admin", "Admin123!")
    response = _create(client, "   ")
    assert response.status_code == 422


def test_create_duplicado_activo_conflict(client):
    _login(client, "admin", "Admin123!")
    assert _create(client, "Almacén").status_code == 201
    response = _create(client, "Almacén")
    assert response.status_code == 409


# --- Actualización ---

def test_patch_renombrar(client):
    _login(client, "admin", "Admin123!")
    role_id = _create(client, "Ventas").json()["id"]
    response = client.patch(
        f"/api/v1/job-roles/{role_id}", json={"name": "Ventas y distribución"}
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Ventas y distribución"


def test_patch_a_nombre_duplicado_conflict(client):
    _login(client, "admin", "Admin123!")
    first = _create(client, "Producción").json()["id"]
    _create(client, "Mantenimiento")
    response = client.patch(f"/api/v1/job-roles/{first}", json={"name": "Mantenimiento"})
    assert response.status_code == 409


def test_patch_desactivar(client):
    _login(client, "admin", "Admin123!")
    role_id = _create(client, "Ayudante").json()["id"]
    response = client.patch(f"/api/v1/job-roles/{role_id}", json={"active": False})
    assert response.status_code == 200
    assert response.json()["active"] is False

    # Sigue en el listado, marcado como inactivo (no se borra historial).
    listing = client.get("/api/v1/job-roles").json()
    assert any(r["id"] == role_id and r["active"] is False for r in listing)


def test_nombre_reutilizable_tras_desactivar(client):
    _login(client, "admin", "Admin123!")
    role_id = _create(client, "Técnico").json()["id"]
    client.patch(f"/api/v1/job-roles/{role_id}", json={"active": False})
    # El plan permite reusar un nombre si el cargo activo anterior no existe.
    response = _create(client, "Técnico")
    assert response.status_code == 201


def test_patch_cargo_inexistente_404(client):
    _login(client, "admin", "Admin123!")
    response = client.patch(
        f"/api/v1/job-roles/{uuid.uuid4()}", json={"name": "Cualquiera"}
    )
    assert response.status_code == 404


def test_patch_como_supervisor_forbidden(client):
    _login(client, "supervisor", "Sup123!")
    response = client.patch(
        f"/api/v1/job-roles/{uuid.uuid4()}", json={"active": False}
    )
    assert response.status_code == 403
