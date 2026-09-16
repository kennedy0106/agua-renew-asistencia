export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    let code: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (body?.detail && typeof body.detail === "object") {
        code = typeof body.detail.code === "string" ? body.detail.code : undefined;
        detail = typeof body.detail.message === "string" ? body.detail.message : detail;
      }
    } catch {
      // sin cuerpo JSON: mantener el mensaje genérico
    }
    throw new ApiError(res.status, detail, code);
  }
  // 204 No Content (p. ej. change-password): no hay cuerpo que parsear.
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export type UserOut = {
  id: string;
  username: string;
  role: string;
  active: boolean;
  must_change_password: boolean;
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
  qr_token: string;
  created_at: string;
  updated_at: string;
};

export type DniLookup = {
  dni: string;
  first_name: string;
  first_last_name: string;
  second_last_name: string | null;
  full_name: string;
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
    first_name: string;
    last_name: string;
    job_role_id: string;
    hire_date?: string | null;
  }) =>
    apiFetch<Employee>("/api/v1/employees", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  lookupDni: (dni: string) =>
    apiFetch<DniLookup>("/api/v1/employees/dni-lookup", {
      method: "POST",
      body: JSON.stringify({ dni }),
    }),
  update: (
    id: string,
    patch: Partial<
      Pick<Employee, "dni" | "first_name" | "last_name" | "job_role_id" | "hire_date" | "termination_date">
    >,
  ) =>
    apiFetch<Employee>(`/api/v1/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deactivate: (id: string) =>
    apiFetch<Employee>(`/api/v1/employees/${id}/deactivate`, { method: "POST" }),
  get: (id: string) => apiFetch<Employee>(`/api/v1/employees/${id}`),
  qrUrl: (id: string) => `${API_URL}/api/v1/employees/${id}/qr`,
  rotateQr: (id: string) =>
    apiFetch<Employee>(`/api/v1/employees/${id}/qr/rotate`, { method: "POST" }),
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
  break_applies_after_minutes: number;
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
  break_applies_after_minutes: number;
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
  use_custom_overtime_rates: boolean;
  custom_first_two_hours_rate: string | null;
  custom_additional_hours_rate: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
};

export type SalaryPayload = {
  effective_from: string;
  monthly_salary: string;
  overtime_enabled: boolean;
  use_custom_overtime_rates: boolean;
  custom_first_two_hours_rate: string | null;
  custom_additional_hours_rate: string | null;
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
  marking_token: string;
  marking_action: "CHECK_IN" | "CHECK_OUT";
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
  event_type?: string | null;
};

export type AttemptStatusResponse = {
  state: "CONFIRMED" | "PENDING" | "EXPIRED_UNCONFIRMED" | "CANCELLED" | "REVIEWED";
  record: AttendanceRecordOut | null;
  evidence_ready?: boolean;
  write_token_valid?: boolean;
  can_restart?: boolean;
  nonce?: string | null;
  resolution_id?: string | null;
  reason?: string | null;
};

export const attendanceApi = {
  pairTerminal: (pairingCode: string) =>
    apiFetch<{ id: string; name: string; device_code: string }>("/api/v1/attendance/terminal/pair", {
      method: "POST",
      body: JSON.stringify({ pairing_code: pairingCode }),
    }),
  identify: (identifier: string) =>
    apiFetch<IdentifyResponse>("/api/v1/attendance/identify", {
      method: "POST",
      body: JSON.stringify({ identifier }),
    }),
  captureEvidence: (markingToken: string, imageBase64: string, contentType = "image/jpeg") =>
    apiFetch<{ id: string; content_type: string }>("/api/v1/attendance/evidence", {
      method: "POST",
      body: JSON.stringify({
        marking_token: markingToken,
        image_base64: imageBase64,
        content_type: contentType,
      }),
    }),
  checkIn: (markingToken: string) =>
    apiFetch<AttendanceRecordOut>("/api/v1/attendance/check-in", {
      method: "POST",
      body: JSON.stringify({ marking_token: markingToken }),
    }),
  checkOut: (markingToken: string) =>
    apiFetch<AttendanceRecordOut>("/api/v1/attendance/check-out", {
      method: "POST",
      body: JSON.stringify({ marking_token: markingToken }),
    }),
  attemptStatus: (markingToken: string) =>
    apiFetch<AttemptStatusResponse>("/api/v1/attendance/attempt/status", {
      method: "POST",
      body: JSON.stringify({ marking_token: markingToken }),
    }),
  resolveAttempt: (markingToken: string, reasonCode: "TOKEN_EXPIRED" | "PHOTO_RETAKE" | "USER_CANCELLED") =>
    apiFetch<AttemptStatusResponse>("/api/v1/attendance/attempt/resolve", {
      method: "POST",
      body: JSON.stringify({ marking_token: markingToken, reason_code: reasonCode }),
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

export type AttendanceDailyItem = {
  employee_id: string;
  employee_name: string | null;
  work_date: string;
  session_count: number;
  gross_minutes: number;
  break_minutes: number;
  break_source: "SCHEDULE" | "OVERRIDE" | "NONE";
  override_requested_minutes: number | null;
  override_limited: boolean;
  worked_minutes: number;
  expected_minutes: number;
  difference_minutes: number;
  has_open_entry: boolean;
  incident_codes: string[];
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
  daily: (params: { employee_id?: string; date_from?: string; date_to?: string } = {}) =>
    apiFetch<AttendanceDailyItem[]>(`/api/v1/attendance/daily${toQueryString(params)}`),
  setBreakOverride: (employeeId: string, workDate: string, requestedBreakMinutes: number, reason: string) =>
    apiFetch<AttendanceDailyItem>(`/api/v1/attendance/daily/${employeeId}/${workDate}/break`, {
      method: "PUT",
      body: JSON.stringify({ requested_break_minutes: requestedBreakMinutes, reason }),
    }),
  clearBreakOverride: (employeeId: string, workDate: string, reason: string) =>
    apiFetch<AttendanceDailyItem>(`/api/v1/attendance/daily/${employeeId}/${workDate}/break`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),
  summary: () => apiFetch<AttendanceSummary>("/api/v1/attendance/summary"),
  correct: (
    recordId: string,
    payload: {
      check_in_at?: string | null;
      check_out_at?: string | null;
      notes?: string | null;
      reason: string;
    },
  ) =>
    apiFetch<AttendanceRecordOut>(`/api/v1/attendance/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  evidenceMeta: (recordId: string) =>
    apiFetch<{
      record_id: string;
      check_in: { id: string | null; captured_at: string | null; content_type: string | null; available: boolean } | null;
      check_out: { id: string | null; captured_at: string | null; content_type: string | null; available: boolean } | null;
    }>(`/api/v1/attendance/${recordId}/evidence`),
  evidenceImage: async (evidenceId: string): Promise<string> => {
    const res = await fetch(`${API_URL}/api/v1/attendance/evidence/${evidenceId}/image`, {
      credentials: "include",
    });
    if (!res.ok) throw new ApiError(res.status, "No se pudo cargar la foto");
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  inspectAttempt: (nonce: string) =>
    apiFetch<{
      nonce: string;
      employee_id: string;
      employee_name: string | null;
      action: string | null;
      device_id: string | null;
      device_name: string | null;
      state: string;
      automatable: boolean;
      record: AttendanceRecordOut | null;
      evidence_ready: boolean;
      resolution: string | null;
    }>(`/api/v1/attendance/attempts/${encodeURIComponent(nonce)}`),
  reviewAttempt: (nonce: string, reason: string) =>
    apiFetch<unknown>(`/api/v1/attendance/attempts/${encodeURIComponent(nonce)}/review`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};

export type ManualAttendanceRow = {
  employee_id: string; worked_minutes_net: number; normal_minutes: number; additional_minutes: number; recovery_minutes: number;
  known_check_in_at?: string | null; known_check_out_at?: string | null; known_break_minutes?: number | null; reason: string;
  day_context?: "ORDINARY" | "UNSCHEDULED" | "SPECIAL"; source_reference?: string | null; payment_method?: "OVERTIME" | "REVIEWED" | null; payment_concept?: string | null; reviewed_additional_amount?: string | null;
  recovery_allocations: { commitment_id: string; minutes: number }[];
};
export type ManualAttendanceDay = ManualAttendanceRow & {
  id: string;
  work_date: string;
  payment_status: string;
  payment_snapshot: Record<string, unknown> | null;
  approved_additional_amount?: string | null;
  version: number;
  created_at: string;
};
export const historicalAttendanceApi = {
  list: (params: { employee_id?: string; date_from?: string; date_to?: string } = {}) => apiFetch<ManualAttendanceDay[]>(`/api/v1/attendance/manual-days${toQueryString(params)}`),
  get: (id: string) => apiFetch<ManualAttendanceDay>(`/api/v1/attendance/manual-days/${id}`),
  preview: (payload: { work_date: string; rows: ManualAttendanceRow[]; idempotency_key: string; approve_additional?: boolean }) => apiFetch<{ work_date: string; rows: unknown[] }>("/api/v1/attendance/manual-days/preview", { method: "POST", body: JSON.stringify(payload) }),
  batch: (payload: { work_date: string; rows: ManualAttendanceRow[]; idempotency_key: string; approve_additional?: boolean }) => apiFetch<{ created: string[] }>("/api/v1/attendance/manual-days/batch", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: ManualAttendanceRow & { expected_version: number }) => apiFetch<ManualAttendanceDay>(`/api/v1/attendance/manual-days/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  approve: (id: string, expected_version: number, expected_snapshot: Record<string, unknown>) => apiFetch<ManualAttendanceDay>(`/api/v1/attendance/manual-days/${id}/payment/approve`, { method: "POST", body: JSON.stringify({ expected_version, expected_snapshot }) }),
  void: (id: string, expected_version: number, reason: string) => apiFetch<ManualAttendanceDay>(`/api/v1/attendance/manual-days/${id}/void`, { method: "POST", body: JSON.stringify({ expected_version, reason }) }),
  commitments: (employeeId?: string) => apiFetch<{ id: string; employee_id: string; permission_date: string; agreed_minutes: number; pending_minutes: number; covered_before: boolean; reference: string }[]>(`/api/v1/attendance/recovery-commitments${toQueryString({ employee_id: employeeId })}`),
  createCommitment: (payload: { employee_id: string; permission_date: string; agreed_minutes: number; covered_before: boolean; reference: string }) => apiFetch<{ id: string }>("/api/v1/attendance/recovery-commitments", { method: "POST", body: JSON.stringify(payload) }),
};

export type AttendanceDevice = {
  id: string;
  name: string;
  device_code: string;
  active: boolean;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AttendanceDeviceCreated = AttendanceDevice & {
  pairing_code: string;
  pairing_expires_at: string;
};

export const devicesApi = {
  list: () => apiFetch<AttendanceDevice[]>("/api/v1/devices"),
  create: (name: string) =>
    apiFetch<AttendanceDeviceCreated>("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  rotate: (id: string) => apiFetch<AttendanceDeviceCreated>(`/api/v1/devices/${id}/pairing-code`, { method: "POST" }),
  revoke: (id: string) => apiFetch<AttendanceDevice>(`/api/v1/devices/${id}/revoke`, { method: "POST" }),
};

// --- Auditoría (solo ADMIN) ---

export type AuditLog = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  reason: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  performed_by: string | null;
  performed_by_username: string | null;
  created_at: string;
};

export const auditApi = {
  list: (params: { entity_id?: string; limit?: number } = {}) =>
    apiFetch<AuditLog[]>(
      `/api/v1/audit-logs${toQueryString({
        entity_id: params.entity_id,
        limit: params.limit !== undefined ? String(params.limit) : undefined,
      })}`,
    ),
};

// --- Ajustes de horas y saldo (Fase 9) ---

export type HourAdjustment = {
  id: string;
  employee_id: string;
  adjustment_date: string;
  minutes: number;
  adjustment_type: "PERMISO" | "RECUPERACION" | "OTRO" | "OVERTIME";
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approved_by: string | null;
  approved_by_username: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Balance = {
  date_from: string;
  date_to: string;
  worked_minutes: number;
  expected_minutes: number;
  adjustment_minutes: number;
  overtime_minutes: number;
  recovery_credit_minutes: number;
  balance_minutes: number;
};

export const adjustmentsApi = {
  list: (employeeId: string) =>
    apiFetch<HourAdjustment[]>(`/api/v1/employees/${employeeId}/adjustments`),
  create: (
    employeeId: string,
    payload: {
      adjustment_date: string;
      minutes: number;
      adjustment_type: HourAdjustment["adjustment_type"];
      reason: string;
    },
  ) =>
    apiFetch<HourAdjustment>(`/api/v1/employees/${employeeId}/adjustments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  approve: (id: string) =>
    apiFetch<HourAdjustment>(`/api/v1/adjustments/${id}/approve`, { method: "PATCH" }),
  reject: (id: string, reason: string) =>
    apiFetch<HourAdjustment>(`/api/v1/adjustments/${id}/reject`, {
      method: "PATCH",
      body: JSON.stringify({ reason }),
    }),
  balance: (employeeId: string, dateFrom?: string, dateTo?: string) =>
    apiFetch<Balance>(
      `/api/v1/employees/${employeeId}/balance${toQueryString({
        date_from: dateFrom,
        date_to: dateTo,
      })}`,
    ),
};

// --- Horas extra (Fase 10) ---

export type OvertimeDetectItem = {
  work_date: string;
  worked_minutes: number;
  expected_minutes: number;
  extra_minutes: number;
};

export type OvertimeValue = {
  date_from: string;
  date_to: string;
  overtime_minutes: number;
  value: string;
  breakdown: {
    adjustment_date: string;
    minutes: number;
    first_two_minutes: number;
    additional_minutes: number;
    first_two_hours_rate: string;
    additional_hours_rate: string;
    source: string;
    hourly_rate: string;
    value: string;
    skip_reason?: string | null;
  }[];
};

export const overtimeApi = {
  detect: (employeeId: string, dateFrom: string, dateTo: string) =>
    apiFetch<OvertimeDetectItem[]>(
      `/api/v1/employees/${employeeId}/overtime/detect${toQueryString({
        date_from: dateFrom,
        date_to: dateTo,
      })}`,
    ),
  value: (employeeId: string, dateFrom: string, dateTo: string) =>
    apiFetch<OvertimeValue>(
      `/api/v1/employees/${employeeId}/overtime/value${toQueryString({
        date_from: dateFrom,
        date_to: dateTo,
      })}`,
    ),
};

// --- Política general de horas extra (seccion_horas_extra.md) ---

export type OvertimePolicy = {
  id: string;
  first_two_hours_rate: string;
  additional_hours_rate: string;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_at: string;
  updated_at: string;
};

export const overtimePolicyApi = {
  active: () => apiFetch<OvertimePolicy | null>("/api/v1/overtime-policy"),
  history: () => apiFetch<OvertimePolicy[]>("/api/v1/overtime-policy/history"),
  create: (payload: {
    effective_from: string;
    first_two_hours_rate: string;
    additional_hours_rate: string;
    reason: string;
  }) =>
    apiFetch<OvertimePolicy>("/api/v1/overtime-policy", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

// --- Cálculo interno de pago (solo ADMIN/BOSS) ---

export type PayrollPeriod = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: "OPEN" | "CALCULATED" | "CLOSED";
  root_period_id: string;
  version: number;
  supersedes_period_id: string | null;
  rectification_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PayrollRecord = {
  id: string;
  payroll_period_id: string;
  employee_id: string;
  employee_name: string | null;
  monthly_salary: string;
  worked_minutes: number;
  expected_minutes: number;
  overtime_minutes: number;
  overtime_amount: string;
  adjustment_minutes: number;
  adjustment_amount: string;
  base_salary: string;
  manual_adjustment: string;
  missing_salary_days: number;
  total: string;
  status: "PREVIEW" | "CONFIRMED" | "EXCLUDED";
  payable: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const payrollApi = {
  periods: () => apiFetch<PayrollPeriod[]>("/api/v1/payroll/periods"),
  createPeriod: (payload: { name: string; start_date: string; end_date: string }) =>
    apiFetch<PayrollPeriod>("/api/v1/payroll/periods", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  calculate: (periodId: string) =>
    apiFetch<PayrollRecord[]>(`/api/v1/payroll/periods/${periodId}/calculate`, {
      method: "POST",
    }),
  records: (periodId: string) =>
    apiFetch<PayrollRecord[]>(`/api/v1/payroll/periods/${periodId}/records`),
  setAdjustment: (recordId: string, amount: string, notes: string) =>
    apiFetch<PayrollRecord>(`/api/v1/payroll/records/${recordId}/adjustment`, {
      method: "PATCH",
      body: JSON.stringify({ amount, notes }),
    }),
  confirm: (periodId: string) =>
    apiFetch<PayrollPeriod>(`/api/v1/payroll/periods/${periodId}/confirm`, {
      method: "POST",
    }),
  summary: (periodId: string) =>
    apiFetch<PayrollSummary>(`/api/v1/payroll/periods/${periodId}/summary`),
  dailyReport: (periodId: string) =>
    apiFetch<PayrollDailyReport>(`/api/v1/payroll/periods/${periodId}/daily-report`, { cache: "no-store" }),
  readiness: (periodId: string) =>
    apiFetch<PayrollReadiness>(`/api/v1/payroll/periods/${periodId}/readiness`),
  rectify: (periodId: string, reason: string) =>
    apiFetch<PayrollPeriod>(`/api/v1/payroll/periods/${periodId}/rectifications`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};

export type PayrollReadinessIssue = {
  code: string;
  message: string;
  employee_id: string | null;
  attendance_record_id: string | null;
};

export type PayrollReadiness = {
  ready: boolean;
  blockers: PayrollReadinessIssue[];
  warnings: PayrollReadinessIssue[];
};

export type PayrollSummary = {
  period_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: "OPEN" | "CALCULATED" | "CLOSED";
  employee_count: number;
  total_base: string;
  total_overtime: string;
  total_manual: string;
  total: string;
};

export type PayrollDailyReportItem = {
  employee_id: string;
  employee_name: string | null;
  work_date: string;
  worked_minutes: number;
  expected_minutes: number;
  recognized_minutes: number;
  status: "FUTURE_PENDING" | "PENDING" | "NO_ATTENDANCE" | "PARTIAL" | "RECOGNIZED";
  base_amount: string;
  recognized_base_amount: string;
  overtime_minutes: number;
  overtime_amount: string;
  recognized_overtime_amount: string;
  approved_adjustment_minutes: number;
  approved_adjustment_amount: string;
  recognized_total_amount: string;
  review_difference_amount: string;
};

export type PayrollEmployeeDailySummary = {
  employee_id: string;
  employee_name: string | null;
  worked_minutes: number;
  expected_minutes: number;
  programmed_base_amount: string;
  recognized_base_amount: string;
  overtime_minutes: number;
  recognized_overtime_amount: string;
  approved_adjustment_minutes: number;
  approved_adjustment_amount: string;
  recognized_total_amount: string;
  future_pending_base_amount: string;
  review_difference_amount: string;
  manual_adjustment: string;
  official_total_snapshot: string;
};

export type PayrollDailyReport = {
  period_id: string;
  start_date: string;
  end_date: string;
  daily: PayrollDailyReportItem[];
  employees: PayrollEmployeeDailySummary[];
};

// --- Usuarios del sistema (Fase 13, solo ADMIN) ---

export type AdminUser = {
  id: string;
  username: string;
  system_role_id: string;
  role: string | null;
  employee_id: string | null;
  employee_name: string | null;
  active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type SystemRole = {
  id: string;
  name: string;
  description: string | null;
};

export const systemRolesApi = {
  list: () => apiFetch<SystemRole[]>("/api/v1/system-roles"),
};

export const usersApi = {
  list: () => apiFetch<AdminUser[]>("/api/v1/users"),
  create: (payload: {
    username: string;
    system_role_id: string;
    employee_id?: string | null;
  }) =>
    apiFetch<AdminUser & { temporary_password: string }>("/api/v1/users", { method: "POST", body: JSON.stringify(payload) }),
  update: (
    userId: string,
    payload: { system_role_id?: string; active?: boolean; employee_id?: string | null },
  ) =>
    apiFetch<AdminUser>(`/api/v1/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  resetPassword: (userId: string, newPassword: string) =>
    apiFetch<AdminUser>(`/api/v1/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    apiFetch<null>("/api/v1/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
};
