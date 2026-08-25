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

export type JobRole = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export const jobRolesApi = {
  list: () => apiFetch<JobRole[]>("/api/v1/job-roles"),
  create: (name: string, description: string | null) =>
    apiFetch<JobRole>("/api/v1/job-roles", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  update: (id: string, patch: Partial<Pick<JobRole, "name" | "description" | "active">>) =>
    apiFetch<JobRole>(`/api/v1/job-roles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

export type Employee = {
  id: string;
  dni: string;
  employee_code: string;
  first_name: string;
  last_name: string;
  job_role_id: string;
  job_role_name: string | null;
  hire_date: string | null;
  termination_date: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function toQueryString(params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const employeesApi = {
  list: (params: { active?: boolean; search?: string } = {}) =>
    apiFetch<Employee[]>(`/api/v1/employees${toQueryString(params)}`),
  create: (payload: {
    dni: string;
    employee_code: string;
    first_name: string;
    last_name: string;
    job_role_id: string;
    hire_date?: string | null;
  }) =>
    apiFetch<Employee>("/api/v1/employees", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (
    id: string,
    patch: Partial<
      Pick<Employee, "dni" | "employee_code" | "first_name" | "last_name" | "job_role_id" | "hire_date" | "termination_date">
    >,
  ) =>
    apiFetch<Employee>(`/api/v1/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deactivate: (id: string) =>
    apiFetch<Employee>(`/api/v1/employees/${id}/deactivate`, { method: "POST" }),
  get: (id: string) => apiFetch<Employee>(`/api/v1/employees/${id}`),
};

export type WorkSchedule = {
  id: string;
  employee_id: string;
  monday_minutes: number;
  tuesday_minutes: number;
  wednesday_minutes: number;
  thursday_minutes: number;
  friday_minutes: number;
  saturday_minutes: number;
  sunday_minutes: number;
  break_minutes: number;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
};

export type SchedulePayload = {
  effective_from: string;
  monday_minutes: number;
  tuesday_minutes: number;
  wednesday_minutes: number;
  thursday_minutes: number;
  friday_minutes: number;
  saturday_minutes: number;
  sunday_minutes: number;
  break_minutes: number;
};

export const scheduleApi = {
  get: (employeeId: string) =>
    apiFetch<WorkSchedule>(`/api/v1/employees/${employeeId}/schedule`),
  history: (employeeId: string) =>
    apiFetch<WorkSchedule[]>(`/api/v1/employees/${employeeId}/schedule/history`),
  set: (employeeId: string, payload: SchedulePayload) =>
    apiFetch<WorkSchedule>(`/api/v1/employees/${employeeId}/schedule`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

export type SalarySetting = {
  id: string;
  employee_id: string;
  monthly_salary: string;
  overtime_enabled: boolean;
  overtime_method: "PERCENTAGE" | "FIXED_RATE" | "MANUAL";
  overtime_percentage: string | null;
  overtime_fixed_rate: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
};

export type SalaryPayload = {
  effective_from: string;
  monthly_salary: string;
  overtime_enabled: boolean;
  overtime_method: "PERCENTAGE" | "FIXED_RATE" | "MANUAL";
  overtime_percentage: string | null;
  overtime_fixed_rate: string | null;
};

export const salaryApi = {
  get: (employeeId: string) =>
    apiFetch<SalarySetting>(`/api/v1/employees/${employeeId}/salary-settings`),
  history: (employeeId: string) =>
    apiFetch<SalarySetting[]>(`/api/v1/employees/${employeeId}/salary-settings/history`),
  set: (employeeId: string, payload: SalaryPayload) =>
    apiFetch<SalarySetting>(`/api/v1/employees/${employeeId}/salary-settings`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

// --- Marcación pública (sin autenticación) ---

export type IdentifyResponse = {
  employee: {
    id: string;
    first_name: string;
    last_name: string;
    job_role_name: string | null;
    active: boolean;
  };
  state: {
    has_open_entry: boolean;
    open_check_in_at: string | null;
    last_record: {
      id: string;
      work_date: string;
      check_in_at: string;
      check_out_at: string | null;
      worked_minutes: number | null;
      status: string;
    } | null;
  };
  server_time: string;
  server_time_label: string;
};

export type AttendanceRecordOut = {
  id: string;
  employee_id: string;
  work_date: string;
  check_in_at: string;
  check_out_at: string | null;
  worked_minutes: number | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const attendanceApi = {
  identify: (identifier: string) =>
    apiFetch<IdentifyResponse>("/api/v1/attendance/identify", {
      method: "POST",
      body: JSON.stringify({ identifier }),
    }),
  checkIn: (employeeId: string) =>
    apiFetch<AttendanceRecordOut>("/api/v1/attendance/check-in", {
      method: "POST",
      body: JSON.stringify({ employee_id: employeeId }),
    }),
  checkOut: (employeeId: string) =>
    apiFetch<AttendanceRecordOut>("/api/v1/attendance/check-out", {
      method: "POST",
      body: JSON.stringify({ employee_id: employeeId }),
    }),
};

// --- Panel de asistencia (autenticado) ---

export type AttendanceListItem = {
  id: string;
  employee_id: string;
  employee_name: string | null;
  job_role_name: string | null;
  work_date: string;
  check_in_at: string;
  check_out_at: string | null;
  worked_minutes: number | null;
  expected_minutes: number;
  difference_minutes: number | null;
  status: string;
  notes: string | null;
};

export type AttendanceSummary = {
  employees_active: number;
  present_today: number;
  no_entry_today: number;
  open_entries: number;
  checked_out_today: number;
};

export const attendanceAdminApi = {
  list: (
    params: { employee_id?: string; date_from?: string; date_to?: string; status?: string } = {},
  ) => apiFetch<AttendanceListItem[]>(`/api/v1/attendance${toQueryString(params)}`),
  summary: () => apiFetch<AttendanceSummary>("/api/v1/attendance/summary"),
};
