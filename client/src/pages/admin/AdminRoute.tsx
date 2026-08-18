import { ShieldX } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { buttonStyles } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * The guard on the whole `/admin` tree.
 *
 * Two things separate this from `ProtectedRoute`, and both are deliberate.
 *
 * It does **not** require a workspace membership. A platform administrator may
 * belong to no workspace at all — running the deployment is not the same job as
 * using it — and `ProtectedRoute`'s default would bounce such an account to
 * `/create-workspace`, locking them out of the one surface that exists
 * precisely to operate on workspaces they are not a member of. The server side
 * of this is the same invariant said twice: the admin router is mounted behind
 * `requirePlatformAdmin` and *not* behind `requireTenant`, because tenant
 * resolution would 404 every call an operator made.
 *
 * And a signed-in non-admin is refused in place rather than redirected. A
 * silent bounce to `/app` leaves someone who typed `/admin` guessing whether
 * the URL was wrong, their account was wrong, or the page had moved. Telling
 * them plainly costs one screen and answers the question.
 *
 * The session states themselves — confirming, unauthenticated — are not
 * reimplemented here. `ProtectedRoute` already owns the skeleton and the
 * `state.from` redirect that returns a user to the page they asked for after
 * signing in; duplicating them would give the platform shell a session
 * behaviour that could drift from the rest of the app.
 */
export interface AdminRouteProps {
  children: ReactNode;
}

function NotAPlatformAdmin(): JSX.Element {
  return (
    // Full height and its own canvas: this refusal renders *instead of* the
    // admin shell, so there is no frame around it to sit inside.
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <EmptyState
        icon={<ShieldX className="size-6" aria-hidden="true" />}
        title="This account is not a platform administrator"
        description="The platform area is limited to operators of this deployment. Your own workspaces are unaffected and you can carry on working in them."
        action={
          <Link to="/app" className={buttonStyles('secondary', 'md')}>
            Back to my workspace
          </Link>
        }
      />
    </div>
  );
}

function RequirePlatformAdmin({ children }: AdminRouteProps): JSX.Element {
  const { user } = useAuth();

  // `user` is populated for every authenticated session, so this only fires on
  // the role check in practice. It is written as one condition rather than a
  // non-null assertion because a narrowing that is merely true today is not
  // worth trading for a crash if the context's contract ever loosens.
  if (!user || user.platformRole !== 'ADMIN') return <NotAPlatformAdmin />;

  return <>{children}</>;
}

export function AdminRoute({ children }: AdminRouteProps): JSX.Element {
  return (
    <ProtectedRoute requireWorkspace={false}>
      <RequirePlatformAdmin>{children}</RequirePlatformAdmin>
    </ProtectedRoute>
  );
}
