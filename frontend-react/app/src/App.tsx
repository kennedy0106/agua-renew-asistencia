import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { Notifications } from "@/components/Notifications";
import RouteFallback from "@/components/RouteFallback";
import AdminLayout from "@/layouts/AdminLayout";
import HomePage from "@/pages/HomePage";
import NotFoundPage from "@/pages/NotFoundPage";
import AdminLoginPage from "@/pages/AdminLoginPage";
import AdminChangePasswordPage from "@/pages/AdminChangePasswordPage";

/**
 * Rutas migradas del frontend Next (17 destinos). El área /admin usa routing
 * anidado: `AdminLayout` resuelve la sesión y aplica los guardas, y cada página
 * provee su propio `AdminShell` (salvo login y cambio de contraseña, que en
 * Next tampoco lo usaban).
 *
 * Las pantallas pesadas se cargan con `React.lazy` para que el bundle inicial
 * no incluya todo el panel; la portada y el flujo de login quedan eager para
 * que el primer render (y el kiosco) sea inmediato.
 */
const AsistenciaPage = lazy(() => import("@/pages/AsistenciaPage"));
const AdminDashboardPage = lazy(() => import("@/pages/AdminDashboardPage"));
const AdminAccountPage = lazy(() => import("@/pages/AdminAccountPage"));
const AdminAttendancePage = lazy(() => import("@/pages/AdminAttendancePage"));
const AdminAttendanceHistoryPage = lazy(() => import("@/pages/AdminAttendanceHistoryPage"));
const AdminAuditPage = lazy(() => import("@/pages/AdminAuditPage"));
const AdminDevicesPage = lazy(() => import("@/pages/AdminDevicesPage"));
const AdminEmployeesPage = lazy(() => import("@/pages/AdminEmployeesPage"));
const AdminEmployeeDetailPage = lazy(() => import("@/pages/AdminEmployeeDetailPage"));
const AdminOvertimePolicyPage = lazy(() => import("@/pages/AdminOvertimePolicyPage"));
const AdminPayrollPage = lazy(() => import("@/pages/AdminPayrollPage"));
const AdminRolesPage = lazy(() => import("@/pages/AdminRolesPage"));
const AdminSalariesPage = lazy(() => import("@/pages/AdminSalariesPage"));
const AdminUsersPage = lazy(() => import("@/pages/AdminUsersPage"));

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
