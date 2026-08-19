/**
 * The frame a customer sees.
 *
 * A third shell beside `components/layout/AppShell.tsx` and
 * `pages/admin/AdminShell.tsx`, and it exists for the same reason the platform
 * one does: the identity it serves cannot satisfy what the tenant frame
 * assumes. `AppShell` renders a workspace switcher and a sidebar filtered by
 * workspace permissions, and a customer holds no membership, so it has nothing
 * to switch between and no permissions to filter by. Shown that frame, they get
 * an empty rail, an empty switcher, and a strong impression that something is
 * broken. `ProtectedRoute` would not even let them that far — with
 * `requireWorkspace` on it sends anyone without a membership to
 * `/create-workspace`, which is the last thing a person checking their haircut
 * appointment wants to be offered.
 *
 * Where the platform shell is deliberately *unlike* the tenant one — a sunken
 * rail, a standing banner, a different mark — this one is deliberately smaller
 * than both. There are three destinations. An operator needs constant reminding
 * of whose data they are looking at; a person reading their own diary does not,
 * and a shell that shouted would only make an ordinary errand feel official.
 * So: one topbar, three links, and the page.
 *
 * Renders an `<Outlet />`, so it is used as a layout route and every page under
 * it inherits the frame without importing it.
 */
import {
  ArrowLeft,
  BellRing,
  CalendarCheck2,
  Check,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserCircle,
} from 'lucide-react';
import { useCallback } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { buttonStyles } from '@/components/ui/Button';
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui/DropdownMenu';
import { useAuth } from '@/context/AuthContext';
import { useTheme, type ThemeMode } from '@/context/ThemeContext';
import { cn } from '@/lib/cn';
import { browserTimezone, formatZoneLabel } from '@/lib/format';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: JSX.Element }> = [
  { mode: 'light', label: 'Light', icon: <Sun className="size-4" aria-hidden="true" /> },
  { mode: 'dark', label: 'Dark', icon: <Moon className="size-4" aria-hidden="true" /> },
  { mode: 'system', label: 'System', icon: <Monitor className="size-4" aria-hidden="true" /> },
];

/**
 * Three destinations, declared inline rather than in a navigation module.
 *
 * `components/layout/navigation.ts` exists because the management sidebar has
 * twenty-odd entries and each needs a permission beside it so the link and the
 * route guard cannot drift. Neither is true here: nothing on this surface is
 * permission-gated, because there are no permissions to gate on.
 */
const PORTAL_NAV = [
  { to: '/portal/bookings', label: 'Bookings', icon: CalendarCheck2 },
  { to: '/portal/preferences', label: 'Preferences', icon: BellRing },
  { to: '/portal/profile', label: 'Account', icon: UserCircle },
] as const;

function PortalNav(): JSX.Element {
  return (
    <nav aria-label="Your account" className="flex items-center gap-1">
      {PORTAL_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              isActive
                ? 'bg-brand-subtle font-semibold text-brand-text'
                : 'font-medium text-fg-secondary hover:bg-surface-hover hover:text-fg',
            )
          }
        >
          <item.icon className="size-4 shrink-0" aria-hidden="true" />
          {/* The label collapses on a phone, not the control: three icons in a
              row are still navigable, whereas a hamburger for three links is
              more machinery than the surface deserves. */}
          <span className="hidden sm:inline">{item.label}</span>
          <span className="mf-sr-only sm:hidden">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function ThemeToggle(): JSX.Element {
  const { mode, theme, setMode } = useTheme();
  const current = THEME_OPTIONS.find((option) => option.mode === mode) ?? THEME_OPTIONS[2];

  return (
    <DropdownMenu
      label="Colour theme"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          {...props}
          type="button"
          // Names both what is set and what is showing: "System" alone does not
          // tell anyone which palette they are looking at.
          aria-label={`Colour theme: ${current?.label ?? 'System'} (currently ${theme})`}
          className="flex size-9 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {theme === 'dark' ? (
            <Moon className="size-4" aria-hidden="true" />
          ) : (
            <Sun className="size-4" aria-hidden="true" />
          )}
        </button>
      )}
    >
      <DropdownLabel>Theme</DropdownLabel>
      {THEME_OPTIONS.map((option) => (
        <DropdownItem
          key={option.mode}
          onSelect={() => setMode(option.mode)}
          icon={mode === option.mode ? <Check className="size-4" /> : option.icon}
        >
          {option.label}
        </DropdownItem>
      ))}
    </DropdownMenu>
  );
}

/**
 * The way into the management app, for somebody who is both a customer and a
 * member somewhere.
 *
 * Shown only when they actually hold a membership. Offering it unconditionally
 * would send a pure customer to `/create-workspace` — an invitation to start a
 * business, which is not what they came for.
 */
function BackToWorkspaceLink(): JSX.Element | null {
  const { memberships } = useAuth();
  if (memberships.length === 0) return null;

  return (
    <Link to="/app" className={buttonStyles('outline', 'sm')} aria-label="Back to my workspace">
      <ArrowLeft className="size-4" aria-hidden="true" />
      <span className="hidden md:inline">My workspace</span>
    </Link>
  );
}

function AccountMenu(): JSX.Element | null {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onSignOut = useCallback(async () => {
    await logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  if (!user) return null;

  return (
    <DropdownMenu
      label="Account"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          {...props}
          type="button"
          aria-label={`Account menu for ${user.email}`}
          className="flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Avatar name={user.email} size="sm" />
        </button>
      )}
    >
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <p className="truncate text-sm font-medium text-fg">{user.email}</p>
      </div>
      <DropdownSeparator />
      <DropdownItem
        icon={<LogOut className="size-4" />}
        destructive
        onSelect={() => {
          void onSignOut();
        }}
      >
        Sign out
      </DropdownItem>
    </DropdownMenu>
  );
}

export function PortalShell(): JSX.Element {
  // The one clock this surface renders in. A person whose bookings span three
  // countries needs a single reference, and the only one that is theirs is the
  // browser's; each page still names a booking's own zone where the two differ.
  const viewerZone = browserTimezone();

  return (
    <div className="min-h-dvh bg-canvas">
      <a href="#main-content" className="mf-skip-link">
        Skip to content
      </a>

      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <div className="mx-auto flex h-[var(--mf-topbar-height)] w-full max-w-4xl items-center gap-3 px-4 sm:px-6">
          <Link
            to="/portal/bookings"
            className="flex shrink-0 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span
              className="flex size-7 items-center justify-center rounded-md bg-brand text-on-brand"
              aria-hidden="true"
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none">
                <rect
                  x="2"
                  y="3"
                  width="12"
                  height="11"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M2 6.5h12M5.5 2v2M10.5 2v2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx="8" cy="10" r="1.25" fill="currentColor" />
              </svg>
            </span>
            <span className="hidden text-base font-semibold tracking-tight text-fg sm:inline">
              MeetFlow
            </span>
          </Link>

          <PortalNav />

          <div className="ml-auto flex items-center gap-2">
            <BackToWorkspaceLink />
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <AccountMenu />
            </div>
          </div>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 focus-visible:outline-none sm:px-6 lg:py-8"
      >
        <Outlet />
      </main>

      <footer className="mx-auto w-full max-w-4xl px-4 pb-10 text-center text-xs text-fg-muted sm:px-6">
        <p className="mb-1">All times are shown in {formatZoneLabel(viewerZone)}.</p>
        <p>Scheduling by MeetFlow</p>
      </footer>
    </div>
  );
}
