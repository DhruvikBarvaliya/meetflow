import { ShieldX } from 'lucide-react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { PermissionKey } from '@/lib/permissions';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { buttonStyles } from '@/components/ui/Button';
import { VerifyEmailGate } from './VerifyEmailGate';

export interface ProtectedRouteProps {
  children: ReactNode;
  /**
   * `false` for the onboarding routes — someone creating their first workspace
   * is signed in but has no membership yet, so demanding one would lock them
   * out of the only page that could fix it.
   */
  requireWorkspace?: boolean;
  /** Permissions required to view the route. */
  permission?: PermissionKey | PermissionKey[];
  /**
   * `any` for pages a role can reach through either a broad or an `:own`
   * grant — a manager holds `appointments:read` and a therapist holds
   * `appointments:read:own`, and the diary belongs to both.
   */
  mode?: 'all' | 'any';
}

/** A quiet stand-in while the session is being confirmed. */
function AuthPending(): JSX.Element {
  return (
    <div
      className="flex min-h-dvh items-center justify-center p-6"
      role="status"
      aria-live="polite"
    >
      <span className="mf-sr-only">Checking your session</span>
      <div className="flex w-full max-w-sm flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
}

export function ProtectedRoute({
  children,
  requireWorkspace = true,
  permission,
  mode = 'all',
}: ProtectedRouteProps): JSX.Element {
  const { status, user, memberships, customerProfiles, canAll, canAny, activeBusinessId } =
    useAuth();
  const location = useLocation();

  if (status === 'loading') return <AuthPending />;

  if (status === 'unauthenticated') {
    // `state.from` is what sends the user back to the page they asked for
    // instead of dumping them on the dashboard after signing in.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  /*
   * Signed in, address unconfirmed.
   *
   * Checked before anything below it, because everything below assumes the
   * queries on the page will answer: the server refuses every authenticated
   * surface except `/auth` with 403 `EMAIL_NOT_VERIFIED`, so rendering onwards
   * produces a screen of failed requests and no explanation of the one thing
   * that would fix them.
   *
   * `user` is null only while the identity query is in flight, which the
   * `loading` branch above has already handled; treating a null as verified
   * here would flash the real page before the gate replaced it.
   */
  if (user !== null && !user.emailVerified) return <VerifyEmailGate />;

  /*
   * No membership, on a route that needs one. Where this goes depends on who
   * the person is, and "no membership" alone does not say.
   *
   * It describes two people with opposite needs: someone who has just
   * registered and is on their way to creating a workspace, and a customer who
   * will never have one. Sending a customer to `/create-workspace` answers
   * "where is my haircut appointment?" with an invitation to start a business.
   * Sending a new owner to the portal drops them into an empty bookings list
   * instead of the onboarding they came for.
   *
   * So the decision is made on a fact rather than on an absence:
   * `customerProfiles` is the number of workspaces holding a customer record
   * for this account, and it is the only thing that distinguishes the two.
   * `/auth/me` reports it for exactly this branch.
   */
  if (requireWorkspace && memberships.length === 0) {
    return <Navigate to={customerProfiles > 0 ? '/portal' : '/create-workspace'} replace />;
  }

  // Memberships exist but reconciliation has not run yet; rendering now would
  // fire every management query without an X-Business-Id.
  if (requireWorkspace && activeBusinessId === null) return <AuthPending />;

  const required = permission ? (Array.isArray(permission) ? permission : [permission]) : [];
  const allowed = mode === 'any' ? canAny(...required) : canAll(...required);
  if (required.length > 0 && !allowed) {
    return (
      <EmptyState
        icon={<ShieldX className="size-6" aria-hidden="true" />}
        title="You do not have access to this page"
        description="Your role in this workspace does not include this area. An owner or manager can change that."
        action={
          <Link to="/app" className={buttonStyles('secondary', 'md')}>
            Back to your dashboard
          </Link>
        }
      />
    );
  }

  return <>{children}</>;
}
