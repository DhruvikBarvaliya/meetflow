import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useParams } from 'react-router-dom';
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
 *
 * There are three shells, and which one a path sits under is a load-bearing
 * decision rather than a matter of taste:
 *
 *   `/app`     AppShell    — a workspace member, working inside one tenant.
 *   `/admin`   AdminShell  — a platform operator, working across all of them.
 *   `/portal`  PortalShell — a customer, working across none of them.
 *
 * `/portal` is a sibling of `/app`, deliberately not a child, for the same
 * reason `/admin` is. A customer holds no membership, and `ProtectedRoute`
 * sends anyone without one to `/create-workspace`; nesting the portal inside
 * the tenant frame would answer "where are my appointments?" with an invitation
 * to start a business. That is the precise defect the portal was built to fix,
 * and re-parenting these routes under `/app` would reintroduce it. The portal's
 * guard therefore passes `requireWorkspace={false}`, and its queries carry no
 * workspace segment, because its data — one person's bookings — spans every
 * workspace they are a customer of and belongs to none of them.
 */
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage'));
const CreateWorkspacePage = lazy(() => import('@/pages/auth/CreateWorkspacePage'));
const ForgotPasswordPage = lazy(() => import('@/pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('@/pages/auth/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('@/pages/auth/VerifyEmailPage'));

const PublicBookingPage = lazy(() => import('@/pages/public/PublicBookingPage'));
const ManageBookingPage = lazy(() => import('@/pages/public/ManageBookingPage'));
const ClaimWaitlistPage = lazy(() => import('@/pages/public/ClaimWaitlistPage'));

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
const AuditLogPage = lazy(() => import('@/pages/owner/AuditLogPage'));
const WebhooksPage = lazy(() => import('@/pages/owner/WebhooksPage'));
const WorkspaceSettingsPage = lazy(() => import('@/pages/owner/WorkspaceSettingsPage'));

const SchedulePage = lazy(() => import('@/pages/staff/SchedulePage'));
const StaffAppointmentDetailPage = lazy(() => import('@/pages/staff/AppointmentDetailPage'));
const MyAvailabilityPage = lazy(() => import('@/pages/staff/MyAvailabilityPage'));
const MyServicesPage = lazy(() => import('@/pages/staff/MyServicesPage'));

const MyAppointmentsPage = lazy(() => import('@/pages/customer/MyAppointmentsPage'));
const PortalBookingDetailPage = lazy(() => import('@/pages/customer/AppointmentDetailPage'));
const PreferencesPage = lazy(() => import('@/pages/customer/PreferencesPage'));
const ProfilePage = lazy(() => import('@/pages/customer/ProfilePage'));

/*
 * The platform and portal shells are lazy alongside their pages rather than
 * imported like `AppShell` above, which every signed-in member lands in. Both
 * are named exports, hence the mapping React.lazy asks for.
 *
 * For `AdminShell` this is also what makes the claim in the header comment true
 * of the whole surface instead of only the pages inside it: the frame itself
 * stays behind `AdminRoute`.
 */
const AdminShell = lazy(() =>
  import('@/pages/admin/AdminShell').then((module) => ({ default: module.AdminShell })),
);

const PortalShell = lazy(() =>
  import('@/pages/customer/PortalShell').then((module) => ({ default: module.PortalShell })),
);

const AdminOverviewPage = lazy(() => import('@/pages/admin/AdminOverviewPage'));
const AdminWorkspacesPage = lazy(() => import('@/pages/admin/AdminWorkspacesPage'));
const AdminWorkspaceDetailPage = lazy(() => import('@/pages/admin/AdminWorkspaceDetailPage'));
const AdminUsersPage = lazy(() => import('@/pages/admin/AdminUsersPage'));
const AdminUserDetailPage = lazy(() => import('@/pages/admin/AdminUserDetailPage'));
const AdminAuditPage = lazy(() => import('@/pages/admin/AdminAuditPage'));
const AdminSecurityPage = lazy(() => import('@/pages/admin/AdminSecurityPage'));
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

/**
 * Sends a retired `/app` booking address to its replacement in the portal,
 * keeping the booking it named.
 *
 * `<Navigate>` cannot do this on its own — its `to` is a literal, so a redirect
 * declared that way would drop `:publicId` and land the reader on the list,
 * wondering which appointment they had just clicked.
 */
function PortalBookingRedirect(): JSX.Element {
  const { publicId } = useParams<{ publicId: string }>();
  return <Navigate to={publicId ? `/portal/bookings/${publicId}` : '/portal/bookings'} replace />;
}

/**
 * The offer page's address, for anyone who followed the API's path instead.
 *
 * `waitlist.links.ts` mints offer emails as `/waitlist/{publicId}`. The
 * `/claim` suffix belongs to `POST /api/v1/waitlist/:publicId/claim` — the
 * request the page sends once the customer accepts — and never appears in a
 * link. Both addresses resolve; only one of them renders the offer.
 */
function WaitlistClaimRedirect(): JSX.Element {
  const { publicId } = useParams<{ publicId: string }>();
  return <Navigate to={publicId ? `/waitlist/${publicId}` : '/'} replace />;
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
  // Account recovery and confirmation, siblings of `/login`. Every one of them
  // is opened from an email by somebody who, by definition, cannot currently
  // sign in, so requiring a session would close the only door they have left.
  { path: '/forgot-password', element: page(ForgotPasswordPage) },
  { path: '/reset-password', element: page(ResetPasswordPage) },
  { path: '/verify-email', element: page(VerifyEmailPage) },
  { path: '/b/:slug', element: page(PublicBookingPage) },
  { path: '/appointments/:publicId', element: page(ManageBookingPage) },
  // The address `waitlist.links.ts` actually builds into every offer email.
  // Matched to the server rather than the other way round: those emails are
  // already sent, and a link resolving to nothing costs the customer the slot
  // while they wait for a page that will never load.
  { path: '/waitlist/:publicId', element: page(ClaimWaitlistPage) },
  { path: '/waitlist/:publicId/claim', element: <WaitlistClaimRedirect /> },

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
      // The read grant gates both of these, not the write one. A Manager holds
      // `audit:read` and `webhooks:read` and has real work to do on each page;
      // the pages gate their own controls on the matching `:manage` grant.
      // Guarding the route on the write permission instead would refuse the
      // whole screen to the role it was largely written for.
      { path: 'audit-log', element: guarded(AuditLogPage, PERMISSIONS.AUDIT_READ) },
      { path: 'webhooks', element: guarded(WebhooksPage, PERMISSIONS.WEBHOOKS_READ) },
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
      // `staff:read` rather than `services:read`: the page reads
      // `GET /staff/:id/services`, and the server gates that on the roster.
      { path: 'my/services', element: guarded(MyServicesPage, PERMISSIONS.STAFF_READ) },

      // Retired. These pages now read `/api/v1/me` and live in the portal,
      // where they work for a customer holding no membership — which is what
      // they were always for. The old addresses stay as redirects because they
      // were reachable for long enough to be bookmarked.
      { path: 'my/bookings', element: <Navigate to="/portal/bookings" replace /> },
      { path: 'my/bookings/:publicId', element: <PortalBookingRedirect /> },
      { path: 'preferences', element: <Navigate to="/portal/preferences" replace /> },
      // `/app/profile` is deliberately not retired with them. `ProfilePage`
      // renders only a page body — it reads no workspace header and no
      // permission — so it is correct under either shell, and a member
      // changing their password should not be thrown out of the workspace
      // frame to do it. `/portal/profile` mounts the same page.
      { path: 'profile', element: guarded(ProfilePage) },

      { path: '*', element: page(NotFoundPage) },
    ],
  },

  // --- Customer portal ------------------------------------------------------
  // A sibling of `/app`, for the reasons set out in the header comment.
  // `requireWorkspace={false}` is the whole point of the tree rather than an
  // exemption from it: the people it serves hold no membership, and the
  // server draws the same line — the `/api/v1/me` endpoints sit behind
  // `authenticate` alone, outside `requireTenant`.
  {
    path: '/portal',
    element: (
      <ProtectedRoute requireWorkspace={false}>
        <Suspense fallback={<RouteFallback />}>
          <PortalShell />
        </Suspense>
      </ProtectedRoute>
    ),
    // `page()` rather than `guarded()` throughout, like the admin tree below
    // and for a mirror-image reason: `ProtectedRoute`'s permissions are
    // workspace permissions, and a customer has no workspace to hold them in.
    // What a person may see here is settled by which records are theirs, which
    // is the server's judgement on each request rather than a permission the
    // client could check ahead of it.
    children: [
      { index: true, element: <Navigate to="/portal/bookings" replace /> },
      { path: 'bookings', element: page(MyAppointmentsPage) },
      { path: 'bookings/:publicId', element: page(PortalBookingDetailPage) },
      { path: 'preferences', element: page(PreferencesPage) },
      { path: 'profile', element: page(ProfilePage) },
      // Keeps a mistyped portal path inside the portal frame, so a customer is
      // not thrown out to the bare not-found page and back through the guard.
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
      { path: 'security', element: page(AdminSecurityPage) },
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
