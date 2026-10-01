import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { Notifications } from "@/components/Notifications";
import RouteFallback from "@/components/RouteFallback";
import AdminLayout from "@/layouts/AdminLayout";
import { routeLoaders } from "@/lib/routePreload";
import HomePage from "@/pages/HomePage";
import NotFoundPage from "@/pages/NotFoundPage";
import AdminLoginPage from "@/pages/AdminLoginPage";
import AdminChangePasswordPage from "@/pages/AdminChangePasswordPage";
import AsistenciaPage from "@/pages/AsistenciaPage";

/**
 * Rutas migradas del frontend Next (17 destinos). El área /admin usa routing
 * anidado: `AdminLayout` resuelve la sesión y aplica los guardas, y cada página
 * provee su propio `AdminShell` (salvo login y cambio de contraseña, que en
 * Next tampoco lo usaban).
 *
 * Las pantallas pesadas se cargan con `React.lazy`, pero sus loaders viven en
 * `lib/routePreload` para que `IntentLink` pueda precargar el mismo chunk por
 * intención y la promesa se reutilice. El kiosco público (`/asistencia`) queda
 * eager: es entrada directa en tablets y su chunk es pequeño, así que cargarlo
 * por adelantado evita el salto de Suspense en el destino más medido.
 */
const AdminDashboardPage = lazy(routeLoaders["/admin/dashboard"]);
const AdminAccountPage = lazy(routeLoaders["/admin/account"]);
const AdminAttendancePage = lazy(routeLoaders["/admin/attendance"]);
const AdminAttendanceHistoryPage = lazy(routeLoaders["/admin/attendance/history"]);
const AdminAuditPage = lazy(routeLoaders["/admin/audit"]);
const AdminDevicesPage = lazy(routeLoaders["/admin/devices"]);
const AdminEmployeesPage = lazy(routeLoaders["/admin/employees"]);
const AdminEmployeeDetailPage = lazy(routeLoaders["/admin/employees/:id"]);
const AdminOvertimePolicyPage = lazy(routeLoaders["/admin/overtime-policy"]);
const AdminPayrollPage = lazy(routeLoaders["/admin/payroll"]);
const AdminRolesPage = lazy(routeLoaders["/admin/roles"]);
const AdminSalariesPage = lazy(routeLoaders["/admin/salaries"]);
const AdminUsersPage = lazy(routeLoaders["/admin/users"]);

export default function App() {
  return (
    <Notifications>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/asistencia" element={<AsistenciaPage />} />

          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<NotFoundPage />} />
            <Route path="login" element={<AdminLoginPage />} />
            <Route path="change-password" element={<AdminChangePasswordPage />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="account" element={<AdminAccountPage />} />
            <Route path="attendance" element={<AdminAttendancePage />} />
            <Route path="attendance/history" element={<AdminAttendanceHistoryPage />} />
            <Route path="audit" element={<AdminAuditPage />} />
            <Route path="devices" element={<AdminDevicesPage />} />
            <Route path="employees" element={<AdminEmployeesPage />} />
            <Route path="employees/:id" element={<AdminEmployeeDetailPage />} />
            <Route path="overtime-policy" element={<AdminOvertimePolicyPage />} />
            <Route path="payroll" element={<AdminPayrollPage />} />
            <Route path="roles" element={<AdminRolesPage />} />
            <Route path="salaries" element={<AdminSalariesPage />} />
            <Route path="users" element={<AdminUsersPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </Notifications>
  );
}
