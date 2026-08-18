import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { PermissionKey } from '@/lib/permissions';

export interface PermissionGateProps {
  /** Required permissions. `mode` decides whether all or any are needed. */
  permission: PermissionKey | PermissionKey[];
  mode?: 'all' | 'any';
  children: ReactNode;
  /** Rendered instead of the children. Defaults to nothing at all. */
  fallback?: ReactNode;
}

/**
 * Hides UI the current role cannot use.
 *
 * A display convenience, never a security boundary: the server authorises every
 * request on its own, so a gate that guesses wrong shows a control that answers
 * 403 rather than one that leaks data.
 */
export function PermissionGate({
  permission,
  mode = 'all',
  children,
  fallback = null,
}: PermissionGateProps): JSX.Element {
  const { canAll, canAny } = useAuth();
  const required = Array.isArray(permission) ? permission : [permission];
  const allowed = mode === 'any' ? canAny(...required) : canAll(...required);
  return <>{allowed ? children : fallback}</>;
}
