import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, isApiError } from '@/lib/apiClient';
import type { PermissionKey } from '@/lib/permissions';
import { session } from '@/lib/session';
import type {
  AuthSession,
  CreateWorkspaceRequest,
  LoginRequest,
  Membership,
  MeResponse,
  RegisterRequest,
  Workspace,
} from '@/types/api';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface Identity {
  me: MeResponse;
  /** Effective permission keys for the active workspace. */
  permissions: string[];
}

interface AuthContextValue {
  status: AuthStatus;
  user: MeResponse['user'] | null;
  memberships: Membership[];
  /** Workspaces holding a customer record for this account. See ProtectedRoute. */
  customerProfiles: number;
  /** The membership matching `activeBusinessId`, or null before one is chosen. */
  activeMembership: Membership | null;
  activeBusinessId: string | null;
  /** The active workspace's IANA zone — the clock every management screen uses. */
  activeTimezone: string;
  /** The caller's own staff profile in this workspace, when they have one. */
  staffProfileId: string | null;
  permissions: ReadonlySet<string>;

  can: (permission: PermissionKey) => boolean;
  canAny: (...permissions: PermissionKey[]) => boolean;
  canAll: (...permissions: PermissionKey[]) => boolean;

  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  createWorkspace: (input: CreateWorkspaceRequest) => Promise<Workspace>;
  logout: () => Promise<void>;
  selectWorkspace: (businessId: string) => void;
  /** Re-reads /auth/me — call after anything that changes membership or role. */
  refreshIdentity: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * What the UI assumes before identity resolves: nothing.
 *
 * Empty rather than optimistic, and deliberately so. An empty set renders a
 * bare screen for a fraction of a second and then fills in; an optimistic set
 * renders buttons that 403 the moment anyone trusts them. The first is a UI
 * that is behind; the second is a UI that is wrong, and being wrong about
 * authorisation is the more expensive of the two.
 */
const EMPTY_PERMISSIONS: ReadonlySet<string> = new Set<string>();

/**
 * The permission set for the workspace the client is acting in — read from the
 * server, never derived here.
 *
 * `GET /auth/me` runs `optionalTenant`, so `activeWorkspace.permissions` is the
 * server's own effective set for this member: the role's grants with per-member
 * GRANT and DENY overrides already applied. This client used to fall back to a
 * hardcoded role table when the field was null, which made those overrides
 * invisible to the UI. It is gone; there is one answer and the server gives it.
 *
 * The businessId guard matters while switching workspaces: a response resolved
 * against the previous workspace must not be read as authority over the next
 * one. `null` passes because the server auto-selects for a caller with exactly
 * one membership, before this provider has reconciled an id of its own.
 */
function resolvePermissions(me: MeResponse, businessId: string | null): string[] {
  const active = me.activeWorkspace;
  if (!active) return [];
  return businessId === null || active.businessId === businessId ? active.permissions : [];
}

async function fetchIdentity(businessId: string | null): Promise<Identity> {
  const me = await api.get<MeResponse>('/auth/me');
  return { me, permissions: resolvePermissions(me, businessId) };
}

/**
 * Picks the workspace to act in.
 *
 * A stored id that is no longer a live membership (removed from the workspace,
 * signed in as someone else) must not stick, or every management call would
 * 404 with no way for the user to recover from the UI.
 */
function reconcileBusinessId(memberships: Membership[], stored: string | null): string | null {
  if (stored && memberships.some((entry) => entry.businessId === stored)) return stored;
  return memberships[0]?.businessId ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [activeBusinessId, setActiveBusinessId] = useState<string | null>(() =>
    session.getActiveBusinessId(),
  );
  const [hasTokens, setHasTokens] = useState<boolean>(() => session.hasSession());

  // The API client can change the tokens outside React (silent refresh), so the
  // provider follows the store rather than owning it.
  useEffect(() => session.onTokensChanged(() => setHasTokens(session.hasSession())), []);

  const identityQuery = useQuery({
    queryKey: ['auth', 'me', activeBusinessId],
    queryFn: () => fetchIdentity(activeBusinessId),
    enabled: hasTokens,
    staleTime: 5 * 60_000,
    // A 401 here already cleared the session in the interceptor; retrying would
    // only delay the redirect to /login.
    retry: false,
  });

  const memberships = useMemo(() => identityQuery.data?.me.memberships ?? [], [identityQuery.data]);

  // Reconciliation runs whenever memberships arrive, so the very first sign-in
  // (no stored id) and a stale id both land on a workspace that exists.
  useEffect(() => {
    if (!identityQuery.data) return;
    const reconciled = reconcileBusinessId(memberships, activeBusinessId);
    if (reconciled !== activeBusinessId) {
      session.setActiveBusinessId(reconciled);
      setActiveBusinessId(reconciled);
    }
  }, [identityQuery.data, memberships, activeBusinessId]);

  // A dead session must not leave another account's data in the cache.
  useEffect(
    () =>
      session.onExpired(() => {
        setHasTokens(false);
        setActiveBusinessId(null);
        queryClient.clear();
      }),
    [queryClient],
  );

  const applySession = useCallback(
    async (authSession: AuthSession) => {
      session.setTokens({
        accessToken: authSession.accessToken,
        refreshToken: authSession.refreshToken,
      });
      setHasTokens(true);
      // Nothing in the cache belongs to this user yet.
      queryClient.clear();
      await queryClient.fetchQuery({
        queryKey: ['auth', 'me', session.getActiveBusinessId()],
        queryFn: () => fetchIdentity(session.getActiveBusinessId()),
      });
    },
    [queryClient],
  );

  const login = useCallback(
    async (input: LoginRequest) => {
      const authSession = await api.post<AuthSession>('/auth/login', input);
      await applySession(authSession);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      const authSession = await api.post<AuthSession>('/auth/register', input);
      await applySession(authSession);
    },
    [applySession],
  );

  const createWorkspace = useCallback(
    async (input: CreateWorkspaceRequest) => {
      const workspace = await api.post<Workspace>('/workspaces', input);
      // Select it before re-reading identity so the new membership resolves its
      // permissions in the same pass.
      session.setActiveBusinessId(workspace.id);
      setActiveBusinessId(workspace.id);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      return workspace;
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    const refreshToken = session.getRefreshToken();
    try {
      // Best effort: the server revokes the token family, but a failed call
      // must never leave the user apparently signed in.
      await api.post('/auth/logout', refreshToken ? { refreshToken } : {});
    } catch (error) {
      if (!isApiError(error)) throw error;
    } finally {
      session.clear();
      setHasTokens(false);
      setActiveBusinessId(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const selectWorkspace = useCallback((businessId: string) => {
    session.setActiveBusinessId(businessId);
    setActiveBusinessId(businessId);
  }, []);

  const refreshIdentity = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
  }, [queryClient]);

  const permissions = useMemo<ReadonlySet<string>>(
    () => (identityQuery.data ? new Set(identityQuery.data.permissions) : EMPTY_PERMISSIONS),
    [identityQuery.data],
  );

  const activeMembership = useMemo(
    () => memberships.find((entry) => entry.businessId === activeBusinessId) ?? null,
    [memberships, activeBusinessId],
  );

  const status = useMemo<AuthStatus>(() => {
    if (!hasTokens) return 'unauthenticated';
    if (identityQuery.data) return 'authenticated';
    // An error here is a dead or unreachable session; the interceptor has
    // already cleared the tokens for the 401 case.
    if (identityQuery.isError) return 'unauthenticated';
    return 'loading';
  }, [hasTokens, identityQuery.data, identityQuery.isError]);

  const can = useCallback(
    (permission: PermissionKey) => permissions.has(permission),
    [permissions],
  );
  const canAny = useCallback(
    (...required: PermissionKey[]) => required.some((permission) => permissions.has(permission)),
    [permissions],
  );
  const canAll = useCallback(
    (...required: PermissionKey[]) => required.every((permission) => permissions.has(permission)),
    [permissions],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: identityQuery.data?.me.user ?? null,
      memberships,
      customerProfiles: identityQuery.data?.me.customerProfiles ?? 0,
      activeMembership,
      activeBusinessId,
      activeTimezone: activeMembership?.timezone ?? 'UTC',
      staffProfileId: identityQuery.data?.me.activeWorkspace?.staffProfileId ?? null,
      permissions,
      can,
      canAny,
      canAll,
      login,
      register,
      createWorkspace,
      logout,
      selectWorkspace,
      refreshIdentity,
    }),
    [
      status,
      identityQuery.data,
      memberships,
      activeMembership,
      activeBusinessId,
      permissions,
      can,
      canAny,
      canAll,
      login,
      register,
      createWorkspace,
      logout,
      selectWorkspace,
      refreshIdentity,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}
