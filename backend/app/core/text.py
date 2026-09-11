"""Validación de textos de negocio: no basta con min_length sobre espacios."""


def require_visible_text(value: str | None, *, min_chars: int = 3, field: str = "motivo") -> str:
    text = (value or "").strip()
    if len(text) < min_chars:
        raise ValueError(f"El {field} debe tener al menos {min_chars} caracteres visibles")
    return text
