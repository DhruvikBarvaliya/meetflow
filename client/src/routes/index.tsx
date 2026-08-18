import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { Skeleton } from '@/components/ui/Skeleton';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';
// Eager, unlike everything else under `@/pages/admin`: this is the guard that
// decides whether the rest of the surface is fetched at all, so it cannot itself
// live behind the boundary it protects. It pulls in nothing the tenant frame has
// not already loaded.
import { AdminRoute } from '@/pages/admin/AdminRoute';

/*
 * Every page is code-split. The auth pages and the public booking flow have no
 * overlap with the management app, so a customer following a booking link never
 * downloads the dashboard, and a signing-in user never downloads the diary.
 *
 * The platform admin surface is split the same way, and there it matters most.
 * `AdminRoute` refuses a non-administrator before any of its children render,
 * so the chunks holding the operator views — every workspace and every account
 * on the deployment — are only ever requested by an account that holds the
 * role. Nobody working in their own diary downloads the panel that could
 * suspend it.
 */
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage'));
const CreateWorkspacePage = lazy(() => import('@/pages/auth/CreateWorkspacePage'));

const PublicBookingPage = lazy(() => import('@/pages/public/PublicBookingPage'));
const ManageBookingPage = lazy(() => import('@/pages/public/ManageBookingPage'));

const DashboardPage = lazy(() => import('@/pages/owner/DashboardPage'));
const CalendarPage = lazy(() => import('@/pages/owner/CalendarPage'));
const AppointmentsPage = lazy(() => import('@/pages/owner/AppointmentsPage'));
const CustomersPage = lazy(() => import('@/pages/owner/CustomersPage'));
const ServicesPage = lazy(() => import('@/pages/owner/ServicesPage'));
const ResourcesPage = lazy(() => import('@/pages/owner/ResourcesPage'));
const LocationsPage = lazy(() => import('@/pages/owner/LocationsPage'));
const TeamsPage = lazy(() => import('@/pages/owner/TeamsPage'));
const StaffPage = lazy(() => import('@/pages/owner/StaffPage'));
const AvailabilityPage = lazy(() => import('@/pages/owner/AvailabilityPage'));
const BookingLinksPage = lazy(() => import('@/pages/owner/BookingLinksPage'));
const WaitlistPage = lazy(() => import('@/pages/owner/WaitlistPage'));
const AnalyticsPage = lazy(() => import('@/pages/owner/AnalyticsPage'));
const ReportsPage = lazy(() => import('@/pages/owner/ReportsPage'));
const MembersPage = lazy(() => import('@/pages/owner/MembersPage'));
const WorkspaceSettingsPage = lazy(() => import('@/pages/owner/WorkspaceSettingsPage'));

const SchedulePage = lazy(() => import('@/pages/staff/SchedulePage'));
const StaffAppointmentDetailPage = lazy(() => import('@/pages/staff/AppointmentDetailPage'));
const MyAvailabilityPage = lazy(() => import('@/pages/staff/MyAvailabilityPage'));

const MyAppointmentsPage = lazy(() => import('@/pages/customer/MyAppointmentsPage'));
const CustomerBookingDetailPage = lazy(() => import('@/pages/customer/AppointmentDetailPage'));
const PreferencesPage = lazy(() => import('@/pages/customer/PreferencesPage'));
const ProfilePage = lazy(() => import('@/pages/customer/ProfilePage'));

/*
 * The platform shell is lazy alongside its pages rather than imported like
 * `AppShell` above. It is the frame an operator works in, not one a tenant user
 * ever sees, and keeping it behind `AdminRoute` is what makes the claim in the
 * header comment true of the whole surface instead of only the pages inside it.
 * `AdminShell` is a named export, hence the mapping React.lazy asks for.
 */
const AdminShell = lazy(() =>
  import('@/pages/admin/AdminShell').then((module) => ({ default: module.AdminShell })),
);

const AdminOverviewPage = lazy(() => import('@/pages/admin/AdminOverviewPage'));
const AdminWorkspacesPage = lazy(() => import('@/pages/admin/AdminWorkspacesPage'));
const AdminWorkspaceDetailPage = lazy(() => import('@/pages/admin/AdminWorkspaceDetailPage'));
const AdminUsersPage = lazy(() => import('@/pages/admin/AdminUsersPage'));
const AdminUserDetailPage = lazy(() => import('@/pages/admin/AdminUserDetailPage'));
const AdminAuditPage = lazy(() => import('@/pages/admin/AdminAuditPage'));
const AdminHealthPage = lazy(() => import('@/pages/admin/AdminHealthPage'));

const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

/** What a page's own area shows while its chunk downloads. */
function RouteFallback(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <span className="mf-sr-only">Loading page</span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * Wraps a lazy page in its own Suspense boundary.
 *
 * One boundary per route rather than one around the whole app: a shared
 * boundary would tear down the sidebar and topbar on every navigation, and the
 * frame flashing is far more jarring than the content area filling in.
 */
function page(Component: ComponentType): ReactNode {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Component />
    </Suspense>
  );
}

/** A protected route with an optional permission requirement. */
function guarded(
  Component: ComponentType,
  permission?: PermissionKey | PermissionKey[],
  mode: 'all' | 'any' = 'all',
): ReactNode {
  return (
    <ProtectedRoute permission={permission} mode={mode}>
      {page(Component)}
    </ProtectedRoute>
  );
}

/** Diary pages: a manager holds the broad grant, a therapist only the `:own` one. */
const DIARY_READ: PermissionKey[] = [
  PERMISSIONS.APPOINTMENTS_READ,
  PERMISSIONS.APPOINTMENTS_READ_OWN,
];

const CUSTOMER_READ: PermissionKey[] = [
  PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.CUSTOMERS_READ_ASSIGNED,
];

const router = createBrowserRouter([
  // --- Public: no session required -----------------------------------------
  { path: '/login', element: page(LoginPage) },
  { path: '/register', element: page(RegisterPage) },
  { path: '/b/:slug', element: page(PublicBookingPage) },
  { path: '/appointments/:publicId', element: page(ManageBookingPage) },

  // Onboarding: signed in, but deliberately *not* requiring a membership —
  // this is the page that creates the first one.
  {
    path: '/create-workspace',
    element: <ProtectedRoute requireWorkspace={false}>{page(CreateWorkspacePage)}</ProtectedRoute>,
  },

  // --- Management app -------------------------------------------------------
  {
    path: '/app',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/app/dashboard" replace /> },
      { path: 'dashboard', element: guarded(DashboardPage) },
      { path: 'calendar', element: guarded(CalendarPage, DIARY_READ, 'any') },
      { path: 'appointments', element: guarded(AppointmentsPage, DIARY_READ, 'any') },
      { path: 'customers', element: guarded(CustomersPage, CUSTOMER_READ, 'any') },
      { path: 'services', element: guarded(ServicesPage, PERMISSIONS.SERVICES_READ) },
      { path: 'resources', element: guarded(ResourcesPage, PERMISSIONS.RESOURCES_READ) },
      { path: 'locations', element: guarded(LocationsPage, PERMISSIONS.LOCATIONS_READ) },
      { path: 'teams', element: guarded(TeamsPage, PERMISSIONS.TEAMS_READ) },
      { path: 'staff', element: guarded(StaffPage, PERMISSIONS.STAFF_READ) },
      { path: 'availability', element: guarded(AvailabilityPage, PERMISSIONS.AVAILABILITY_READ) },
      {
        path: 'booking-links',
        element: guarded(BookingLinksPage, PERMISSIONS.BOOKING_LINKS_READ),
      },
      { path: 'waitlist', element: guarded(WaitlistPage, PERMISSIONS.WAITLIST_READ) },
      { path: 'analytics', element: guarded(AnalyticsPage, PERMISSIONS.ANALYTICS_READ) },
      { path: 'reports', element: guarded(ReportsPage, PERMISSIONS.REPORTS_READ) },
      { path: 'members', element: guarded(MembersPage, PERMISSIONS.MEMBERS_READ) },
      { path: 'settings', element: guarded(WorkspaceSettingsPage, PERMISSIONS.WORKSPACE_READ) },

      { path: 'my/schedule', element: guarded(SchedulePage, DIARY_READ, 'any') },
      // The static segment above is declared first, but ranking — not order —
      // is what keeps `/my/schedule` out of this dynamic route's hands.
      {
        path: 'my/schedule/:appointmentId',
        element: guarded(StaffAppointmentDetailPage, DIARY_READ, 'any'),
      },
      {
        path: 'my/availability',
        element: guarded(MyAvailabilityPage, PERMISSIONS.AVAILABILITY_MANAGE_OWN),
      },
      { path: 'my/bookings', element: guarded(MyAppointmentsPage) },
      { path: 'my/bookings/:publicId', element: guarded(CustomerBookingDetailPage) },
      { path: 'preferences', element: guarded(PreferencesPage) },
      { path: 'profile', element: guarded(ProfilePage) },

      { path: '*', element: page(NotFoundPage) },
    ],
  },

  // --- Platform administration ----------------------------------------------
  // A sibling of `/app`, deliberately not a child of it. The admin surface has
  // its own shell and its own guard, and nesting it under the tenant frame would
  // wrap a view that spans every workspace in a workspace switcher and a sidebar
  // filtered by workspace permissions — permissions a platform administrator,
  // who may hold no membership anywhere on the deployment, does not have. The
  // server draws the same line: `/api/v1/admin` sits behind
  // `requirePlatformAdmin` and *not* behind `requireTenant`.
  {
    path: '/admin',
    element: (
      <AdminRoute>
        <Suspense fallback={<RouteFallback />}>
          <AdminShell />
        </Suspense>
      </AdminRoute>
    ),
    // `page()` rather than `guarded()` throughout: `AdminRoute` has already
    // settled the session and the one bit that governs this whole tree, and
    // `ProtectedRoute`'s permissions are workspace permissions, which do not
    // apply to an operator with no workspace.
    children: [
      { index: true, element: page(AdminOverviewPage) },
      { path: 'workspaces', element: page(AdminWorkspacesPage) },
      // `:id` on both detail routes, because that is the name the pages read
      // from `useParams`; renaming it here would silently hand them undefined.
      { path: 'workspaces/:id', element: page(AdminWorkspaceDetailPage) },
      { path: 'users', element: page(AdminUsersPage) },
      { path: 'users/:id', element: page(AdminUserDetailPage) },
      { path: 'audit', element: page(AdminAuditPage) },
      { path: 'health', element: page(AdminHealthPage) },
      // Keeps a mistyped admin path inside the platform shell, so the operator
      // is not thrown out to the bare not-found page and back through the guard.
      { path: '*', element: page(NotFoundPage) },
    ],
  },

  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '*', element: page(NotFoundPage) },
]);

/** Rendered by App, inside every provider the pages depend on. */
export function AppRoutes(): JSX.Element {
  return <RouterProvider router={router} />;
}

/** Exported for tests and for any caller that needs to build its own provider tree. */
export { router };
