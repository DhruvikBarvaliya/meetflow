import {
  ArrowLeft,
  Check,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useTheme, type ThemeMode } from '@/context/ThemeContext';
import { useIsDesktop } from '@/hooks/useMediaQuery';
import { useScrollLock } from '@/hooks/useScrollLock';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button, buttonStyles } from '@/components/ui/Button';
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui/DropdownMenu';
import { ADMIN_NAVIGATION } from './adminNavigation';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: JSX.Element }> = [
  { mode: 'light', label: 'Light', icon: <Sun className="size-4" aria-hidden="true" /> },
  { mode: 'dark', label: 'Dark', icon: <Moon className="size-4" aria-hidden="true" /> },
  { mode: 'system', label: 'System', icon: <Monitor className="size-4" aria-hidden="true" /> },
];

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SidebarNav({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  return (
    <nav aria-label="Platform" className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
      {ADMIN_NAVIGATION.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              // The active item is a raised chip on the sunken ground rather
              // than the tenant app's brand tint — the same cue, in the one
              // palette this shell is allowed to use. `hover:bg-surface-hover`
              // is avoided for the same reason: that token is tuned to sit a
              // step above `bg-surface` and all but vanishes against
              // `bg-surface-sunken`.
              isActive
                ? 'bg-surface font-semibold text-fg shadow-xs'
                : 'font-medium text-fg-secondary hover:bg-surface hover:text-fg',
            )
          }
        >
          <item.icon className="size-4 shrink-0" aria-hidden={true} />
          <span className="truncate">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The wordmark, with "Platform" under it.
 *
 * The sub-label is not decoration. It is the thing an operator glances at to
 * confirm which of the two shells they are typing into before they suspend
 * somebody's workspace.
 */
function SidebarBrand(): JSX.Element {
  return (
    <Link
      to="/admin"
      className="flex h-[var(--mf-topbar-height)] shrink-0 items-center gap-2.5 border-b border-border-strong px-5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
    >
      {/* Slate rather than brand teal: the tenant shell owns the teal mark, and
          two identical marks would defeat the point of two shells. `fg` on
          `fg-inverse` is a token pair, not an invented colour, and it inverts
          correctly with the theme. */}
      <span
        className="flex size-7 items-center justify-center rounded-md bg-fg text-fg-inverse"
        aria-hidden="true"
      >
        <ShieldCheck className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-base font-semibold tracking-tight text-fg">MeetFlow</span>
        <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-fg-muted">
          Platform
        </span>
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Topbar controls
// ---------------------------------------------------------------------------

/**
 * The way back to the operator's own diary.
 *
 * Rendered only when they actually hold a membership. An admin with none would
 * otherwise be offered a door that opens onto `/create-workspace`, and an
 * operator does not want a workspace — they want the deployment. Offering the
 * link regardless would also read as "you have a workspace over here", which
 * for a support account is simply untrue.
 */
function BackToWorkspaceLink(): JSX.Element | null {
  const { memberships } = useAuth();

  if (memberships.length === 0) return null;

  return (
    <Link to="/app" className={buttonStyles('outline', 'sm')} aria-label="Back to my workspace">
      <ArrowLeft className="size-4" aria-hidden="true" />
      {/* The label collapses on a phone rather than the whole control: the way
          out of the platform surface is the last thing that should need a menu
          to find. */}
      <span className="hidden sm:inline">Back to my workspace</span>
    </Link>
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
        {/* The capacity, not a role in a workspace. Whoever is reading this menu
            is signed in as the account that can suspend any workspace on the
            deployment, and the menu should say so. */}
        <p className="truncate text-xs text-fg-muted">Platform administrator</p>
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

/**
 * The standing reminder of whose data is on screen.
 *
 * It sits inside the sticky region rather than at the top of the page, so it
 * survives scrolling: the moment it can be scrolled away is the moment an
 * operator halfway down a table of fifty workspaces forgets that the row under
 * their cursor belongs to somebody else's business.
 */
function PlatformBanner(): JSX.Element {
  return (
    <div
      role="note"
      className="flex items-center gap-2 border-b border-warning-border bg-warning-subtle px-4 py-1.5 text-xs font-medium text-warning-text sm:px-6"
    >
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Platform administration — you are acting across every workspace on this deployment.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * The platform-administration frame.
 *
 * Structurally this is `components/layout/AppShell.tsx` — fixed sidebar on
 * desktop, overlay drawer below `lg`, sticky topbar, skip link, focusable
 * `<main>` — because an operator should not have to relearn where the
 * navigation lives. What differs is everything that answers "which application
 * am I in": a sunken sidebar with a stronger edge, a "Platform" sub-label under
 * the wordmark, and a banner strip that never scrolls away.
 *
 * That distinction is load-bearing rather than cosmetic. The destructive
 * actions on this surface — suspending a workspace, deactivating an account —
 * are irreversible from the point of view of the person on the receiving end,
 * and the failure mode worth designing against is an operator who believes they
 * are tidying up their own diary. Colour is spent on the banner alone; the
 * pages inside keep the same calm Card and Table vocabulary as the rest of the
 * product, because a screen that shouts on every row stops being read.
 *
 * Renders an `<Outlet />`, so it is used as a layout route and every page under
 * it inherits the frame without importing it.
 */
export function AdminShell(): JSX.Element {
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

      {/* Desktop sidebar. Sunken surface and the stronger border are the whole
          of the "darker rail" treatment — no new colours, and it inverts with
          the theme like everything else. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--mf-sidebar-width)] flex-col border-r border-border-strong bg-surface-sunken lg:flex">
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
            aria-label="Platform navigation"
            className="mf-animate-slide-in-right absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r border-border-strong bg-surface-sunken shadow-xl"
          >
            <div className="flex h-[var(--mf-topbar-height)] shrink-0 items-center justify-between border-b border-border-strong pl-5 pr-3">
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-base font-semibold tracking-tight text-fg">MeetFlow</span>
                <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-fg-muted">
                  Platform
                </span>
              </span>
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
        {/* Topbar and banner stick as one block, so the reminder cannot be
            scrolled out from under the controls it qualifies. */}
        <div className="sticky top-0 z-20">
          <header className="flex h-[var(--mf-topbar-height)] items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/80 sm:px-6">
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

            {/* The wordmark lives in the sidebar on desktop, which is off-screen
                below `lg` — without this the small-screen topbar would name
                neither the product nor the surface. */}
            <span className="text-sm font-semibold tracking-tight text-fg lg:hidden">Platform</span>

            <div className="ml-auto flex items-center gap-2">
              <BackToWorkspaceLink />
              <div className="flex items-center gap-1">
                <ThemeToggle />
                <UserMenu />
              </div>
            </div>
          </header>

          <PlatformBanner />
        </div>

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
