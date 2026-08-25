const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include", // la cookie de sesión viaja en cada request
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });

  if (!res.ok) {
    let detail = `Error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // sin cuerpo JSON: mantener el mensaje genérico
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export type UserOut = {
  id: string;
  username: string;
  role: string;
  active: boolean;
  last_login_at: string | null;
  created_at: string;
};

export const authApi = {
  login: (username: string, password: string) =>
    apiFetch<UserOut>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => apiFetch<UserOut>("/api/v1/auth/me"),
  logout: () => apiFetch<{ status: string }>("/api/v1/auth/logout", { method: "POST" }),
};
