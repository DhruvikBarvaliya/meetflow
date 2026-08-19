import {
  Building2,
  CalendarCheck2,
  Check,
  ChevronsUpDown,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  UserCircle,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useTheme, type ThemeMode } from '@/context/ThemeContext';
import { useIsDesktop } from '@/hooks/useMediaQuery';
import { useScrollLock } from '@/hooks/useScrollLock';
import { cn } from '@/lib/cn';
import { SYSTEM_ROLE_LABELS, isSystemRoleKey } from '@/lib/permissions';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  DropdownItem,
  DropdownLabel,
  DropdownLinkItem,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui/DropdownMenu';
import { NAVIGATION, type NavItem } from './navigation';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: JSX.Element }> = [
  { mode: 'light', label: 'Light', icon: <Sun className="size-4" aria-hidden="true" /> },
  { mode: 'dark', label: 'Dark', icon: <Moon className="size-4" aria-hidden="true" /> },
  { mode: 'system', label: 'System', icon: <Monitor className="size-4" aria-hidden="true" /> },
];

function roleLabel(roleKey: string, fallback: string): string {
  return isSystemRoleKey(roleKey) ? SYSTEM_ROLE_LABELS[roleKey] : fallback;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SidebarNav({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const { canAll, canAny } = useAuth();

  const allowed = (item: NavItem): boolean => {
    if (!item.permission || item.permission.length === 0) return true;
    return item.mode === 'any' ? canAny(...item.permission) : canAll(...item.permission);
  };

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {NAVIGATION.map((section, index) => {
        const items = section.items.filter(allowed);
        // A section whose every item is hidden by permission leaves no empty
        // heading behind.
        if (items.length === 0) return null;

        return (
          <div key={section.label ?? `section-${index}`} className="flex flex-col gap-1">
            {section.label ? (
              <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {section.label}
              </h2>
            ) : null}
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    isActive
                      ? 'bg-brand-subtle text-brand-text'
                      : 'text-fg-secondary hover:bg-surface-hover hover:text-fg',
                  )
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden={true} />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function SidebarBrand(): JSX.Element {
  return (
    <Link
      to="/app"
      className="flex h-[var(--mf-topbar-height)] shrink-0 items-center gap-2.5 border-b border-border px-5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
    >
      <span
        className="flex size-7 items-center justify-center rounded-md bg-brand text-on-brand"
        aria-hidden="true"
      >
        <CalendarGlyph />
      </span>
      <span className="text-base font-semibold tracking-tight text-fg">MeetFlow</span>
    </Link>
  );
}

function CalendarGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2 6.5h12M5.5 2v2M10.5 2v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10" r="1.25" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Topbar controls
// ---------------------------------------------------------------------------

function WorkspaceSwitcher(): JSX.Element | null {
  const { memberships, activeMembership, selectWorkspace } = useAuth();

  if (!activeMembership) return null;

  // With a single workspace there is nothing to switch between; a menu that
  // only ever contains the current item is noise.
  if (memberships.length === 1) {
    return (
      <div className="hidden min-w-0 items-center gap-2 rounded-md px-2 py-1.5 sm:flex">
        <Building2 className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-fg">
          {activeMembership.businessName}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu
      label="Switch workspace"
      align="start"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          {...props}
          type="button"
          className="flex min-w-0 max-w-56 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Building2 className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          <span className="truncate font-medium text-fg">{activeMembership.businessName}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
      )}
    >
      <DropdownLabel>Workspaces</DropdownLabel>
      {memberships.map((membership) => (
        <DropdownItem
          key={membership.businessId}
          onSelect={() => selectWorkspace(membership.businessId)}
          icon={
            membership.businessId === activeMembership.businessId ? (
              <Check className="size-4" />
            ) : null
          }
        >
          <span className="flex flex-col">
            <span className="truncate font-medium text-fg">{membership.businessName}</span>
            <span className="truncate text-xs text-fg-muted">
              {roleLabel(membership.roleKey, membership.roleName)}
            </span>
          </span>
        </DropdownItem>
      ))}
      <DropdownSeparator />
      <DropdownLinkItem to="/create-workspace" icon={<Plus className="size-4" />}>
        Create a workspace
      </DropdownLinkItem>
    </DropdownMenu>
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
          // Says both what is set and what is showing, because "System" alone
          // does not tell a user which palette they are looking at.
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

function UserMenu(): JSX.Element | null {
  const { user, activeMembership, logout } = useAuth();
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
        {activeMembership ? (
          <p className="truncate text-xs text-fg-muted">
            {roleLabel(activeMembership.roleKey, activeMembership.roleName)} ·{' '}
            {activeMembership.businessName}
          </p>
        ) : null}
      </div>
      <DropdownSeparator />
      <DropdownLinkItem to="/app/profile" icon={<UserCircle className="size-4" />}>
        My profile
      </DropdownLinkItem>
      {/*
       * The bridge to the customer portal, and the mirror of the
       * `My workspace` link `PortalShell` shows on the way back.
       *
       * Here rather than in the sidebar for the same reason as the platform
       * link below: that list is workspace navigation, filtered by workspace
       * permissions, and a person's own bookings are a property of the account
       * rather than of any membership. `/app/my/bookings` and
       * `/app/preferences` used to carry this and now redirect here.
       *
       * Shown unconditionally, because whether this account holds a customer
       * record anywhere is only answerable by `GET /api/v1/me/profile` — an
       * async call this menu has no business making just to decide whether to
       * render one item. The portal states plainly when it finds no records,
       * which is a better outcome than a member who books with a colleague's
       * business having no way through at all.
       */}
      <DropdownLinkItem to="/portal/bookings" icon={<CalendarCheck2 className="size-4" />}>
        My bookings
      </DropdownLinkItem>
      {/*
       * The one bridge from the tenant app to the platform surface. It is
       * deliberately not in the sidebar: that list is workspace navigation,
       * filtered by workspace permissions, and platform administration is not
       * one of them — it is a property of the account, not of a membership.
       * Without this entry `/admin` exists but nothing anywhere links to it, and
       * an operator has to know to type the URL.
       *
       * Gated on the same bit the server gates `/api/v1/admin` on, so the link
       * is never shown to someone the API would refuse. Its own group, above the
       * sign-out separator, because leaving the workspace for the platform is a
       * change of surface rather than another account setting.
       */}
      {user.platformRole === 'ADMIN' ? (
        <>
          <DropdownSeparator />
          <DropdownLinkItem to="/admin" icon={<ShieldCheck className="size-4" />}>
            Platform administration
          </DropdownLinkItem>
        </>
      ) : null}
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

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * The signed-in frame: a persistent sidebar on desktop, an overlay drawer on
 * small screens, and a topbar carrying workspace, theme and account controls.
 *
 * Renders an `<Outlet />`, so it is used as a layout route and every page under
 * it inherits the frame without importing it.
 */
export function AppShell(): JSX.Element {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const location = useLocation();

  useScrollLock(mobileNavOpen && !isDesktop);

  // A route change must close the drawer, or tapping a link leaves the overlay
  // covering the page it just opened.
  useEffect(() => setMobileNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (isDesktop) setMobileNavOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  return (
    <div className="min-h-dvh bg-canvas">
      <a href="#main-content" className="mf-skip-link">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--mf-sidebar-width)] flex-col border-r border-border bg-surface lg:flex">
        <SidebarBrand />
        <SidebarNav />
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="mf-animate-fade-in absolute inset-0 bg-overlay"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="mf-animate-slide-in-right absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r border-border bg-surface shadow-xl"
          >
            <div className="flex h-[var(--mf-topbar-height)] shrink-0 items-center justify-between border-b border-border pl-5 pr-3">
              <span className="text-base font-semibold tracking-tight text-fg">MeetFlow</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <SidebarNav onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="lg:pl-[var(--mf-sidebar-width)]">
        <header className="sticky top-0 z-20 flex h-[var(--mf-topbar-height)] items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/80 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="size-9 lg:hidden"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>

          <WorkspaceSwitcher />

          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-[var(--mf-content-max)] flex-col gap-6 px-4 py-6 focus-visible:outline-none sm:px-6 lg:py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
