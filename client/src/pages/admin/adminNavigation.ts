import {
  Activity,
  Building2,
  LayoutDashboard,
  ScrollText,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface AdminNavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /**
   * `true` only where a broader path would otherwise stay lit. Omitting it lets
   * a detail page keep its parent highlighted — `/admin/workspaces/:id` should
   * read as "still in Workspaces".
   */
  end?: boolean;
}

/**
 * The platform sidebar, in one place.
 *
 * The tenant navigation in `components/layout/navigation.ts` carries a
 * `permission` field per entry so a link never leads somewhere the caller would
 * be refused. There is deliberately no such field here: the platform-admin
 * surface is all-or-nothing. `requirePlatformAdmin` on the server gates the
 * whole `/api/v1/admin` mount on one bit — `user.platformRole === 'ADMIN'` —
 * and `AdminRoute` gates the whole `/admin` tree on the same bit. Anyone who
 * can see this sidebar can open every entry in it, so a per-item permission
 * would be a filter that never filters, and the sort of dead abstraction that
 * later gets trusted as if it did something.
 *
 * One flat list rather than the tenant app's labelled sections: five entries do
 * not need grouping, and headings over groups of one or two would imply a
 * structure the surface does not have.
 */
export const ADMIN_NAVIGATION: AdminNavItem[] = [
  // `end` matters on this one alone: every other admin path is prefixed by
  // `/admin`, so without it Overview would stay active on all five screens.
  { label: 'Overview', to: '/admin', icon: LayoutDashboard, end: true },
  { label: 'Workspaces', to: '/admin/workspaces', icon: Building2 },
  { label: 'Users', to: '/admin/users', icon: Users },
  { label: 'Audit log', to: '/admin/audit', icon: ScrollText },
  // Between the audit log and system health because that is where it sits in
  // an incident: the log is the raw trail, Security is the sign-in and
  // recovery signal read out of it, and health is the dependency picture.
  // Every figure on it is a count from the same `/admin/audit-logs` endpoint
  // the audit page reads, so the two never disagree.
  { label: 'Security', to: '/admin/security', icon: ShieldAlert },
  { label: 'System health', to: '/admin/health', icon: Activity },
];
