import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { Skeleton } from '@/components/ui/Skeleton';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';

/*
 * Every page is code-split. The auth pages and the public booking flow have no
 * overlap with the management app, so a customer following a booking link never
 * downloads the dashboard, and a signing-in user never downloads the diary.
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

  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '*', element: page(NotFoundPage) },
]);

/** Rendered by App, inside every provider the pages depend on. */
export function AppRoutes(): JSX.Element {
  return <RouterProvider router={router} />;
}

/** Exported for tests and for any caller that needs to build its own provider tree. */
export { router };
