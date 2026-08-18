import {
  BarChart3,
  BellRing,
  CalendarDays,
  CalendarRange,
  ClipboardList,
  Contact,
  FileSpreadsheet,
  Hourglass,
  LayoutDashboard,
  Link2,
  MapPin,
  Package,
  Settings,
  Sparkles,
  UserCircle,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Omit to show the item to every member of a workspace. */
  permission?: PermissionKey[];
  /** `any` for pages reachable through either a broad or an `:own` permission. */
  mode?: 'all' | 'any';
  /** Matches child routes too, so a detail page keeps its parent highlighted. */
  end?: boolean;
}

export interface NavSection {
  /** Omitted on the first group, which needs no heading above the first item. */
  label?: string;
  items: NavItem[];
}

/**
 * The sidebar, in one place.
 *
 * Each entry names the permission the *page* needs, so the navigation and the
 * route guard cannot drift: a link that appears always leads somewhere the
 * caller can actually open.
 */
export const NAVIGATION: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/app/dashboard', icon: LayoutDashboard, end: true },
      {
        label: 'Calendar',
        to: '/app/calendar',
        icon: CalendarDays,
        permission: [PERMISSIONS.APPOINTMENTS_READ, PERMISSIONS.APPOINTMENTS_READ_OWN],
        mode: 'any',
      },
      {
        label: 'Appointments',
        to: '/app/appointments',
        icon: ClipboardList,
        permission: [PERMISSIONS.APPOINTMENTS_READ, PERMISSIONS.APPOINTMENTS_READ_OWN],
        mode: 'any',
      },
      {
        label: 'Waitlist',
        to: '/app/waitlist',
        icon: Hourglass,
        permission: [PERMISSIONS.WAITLIST_READ],
      },
    ],
  },
  {
    label: 'Clients',
    items: [
      {
        label: 'Customers',
        to: '/app/customers',
        icon: Contact,
        permission: [PERMISSIONS.CUSTOMERS_READ, PERMISSIONS.CUSTOMERS_READ_ASSIGNED],
        mode: 'any',
      },
      {
        label: 'Booking links',
        to: '/app/booking-links',
        icon: Link2,
        permission: [PERMISSIONS.BOOKING_LINKS_READ],
      },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      {
        label: 'Services',
        to: '/app/services',
        icon: Sparkles,
        permission: [PERMISSIONS.SERVICES_READ],
      },
      {
        label: 'Resources',
        to: '/app/resources',
        icon: Package,
        permission: [PERMISSIONS.RESOURCES_READ],
      },
      {
        label: 'Locations',
        to: '/app/locations',
        icon: MapPin,
        permission: [PERMISSIONS.LOCATIONS_READ],
      },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Staff', to: '/app/staff', icon: Users, permission: [PERMISSIONS.STAFF_READ] },
      { label: 'Teams', to: '/app/teams', icon: UsersRound, permission: [PERMISSIONS.TEAMS_READ] },
      {
        label: 'Availability',
        to: '/app/availability',
        icon: CalendarRange,
        permission: [PERMISSIONS.AVAILABILITY_READ],
      },
    ],
  },
  {
    label: 'Insight',
    items: [
      {
        label: 'Analytics',
        to: '/app/analytics',
        icon: BarChart3,
        permission: [PERMISSIONS.ANALYTICS_READ],
      },
      {
        label: 'Reports',
        to: '/app/reports',
        icon: FileSpreadsheet,
        permission: [PERMISSIONS.REPORTS_READ],
      },
    ],
  },
  {
    label: 'Mine',
    items: [
      {
        label: 'My schedule',
        to: '/app/my/schedule',
        icon: CalendarDays,
        permission: [PERMISSIONS.APPOINTMENTS_READ_OWN, PERMISSIONS.APPOINTMENTS_READ],
        mode: 'any',
      },
      {
        label: 'My availability',
        to: '/app/my/availability',
        icon: CalendarRange,
        permission: [PERMISSIONS.AVAILABILITY_MANAGE_OWN],
      },
      { label: 'My bookings', to: '/app/my/bookings', icon: ClipboardList },
      { label: 'Preferences', to: '/app/preferences', icon: BellRing },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        label: 'Members',
        to: '/app/members',
        icon: UsersRound,
        permission: [PERMISSIONS.MEMBERS_READ],
      },
      {
        label: 'Settings',
        to: '/app/settings',
        icon: Settings,
        permission: [PERMISSIONS.WORKSPACE_READ],
      },
      { label: 'My profile', to: '/app/profile', icon: UserCircle },
    ],
  },
];
