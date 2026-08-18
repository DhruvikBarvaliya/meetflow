import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import { MembershipStatusBadge } from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
  useToast,
  type BadgeTone,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { isApiError } from '@/lib/apiClient';
import {
  browserTimezone,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatZoneLabel,
  humanizeEnum,
} from '@/lib/format';
import type {
  AdminUserDetail,
  AdminUserStatusUpdate,
  AdminWorkspaceStatus,
  PlatformRole,
  UserStatus,
} from '@/types/api';
import { fetchAdminUser, updateAdminPlatformRole, updateAdminUserStatus } from './adminApi';
import { adminKeys } from './adminKeys';
import { AccountStatusBadge, PlatformRoleBadge } from './AdminUsersPage';

/**
 * One account, and the two decisions an operator can take about it.
 *
 * Everything above the controls is there to be read before either of them is
 * taken: which workspaces this person belongs to, which ones they own, whether
 * they are locked out by the login throttle rather than by anybody's decision,
 * and how many devices are still signed in. A suspension taken without that
 * context is the support ticket this screen exists to prevent.
 *
 * It keeps the admin API's privacy boundary. There is nothing here about what
 * this person has booked, cancelled or written down — only which workspaces
 * they can reach and in what capacity. The API has no field for the rest.
 *
 * Both mutations are guarded on the server as well as here, and the guards are
 * not the same thing. The server's are the enforcement: it refuses to change
 * the caller's own account, and refuses to demote the last active
 * administrator, both with a 409. The client's are courtesy — a disabled button
 * with a sentence beside it is a better answer than a button that fails when
 * pressed. Where the client cannot know the answer in advance (the last-admin
 * rule depends on rows this screen has not read), the 409's message is shown
 * verbatim rather than replaced with a generic failure.
 */

/**
 * Shown beside both controls when an operator is looking at their own account.
 *
 * The server refuses these two changes for the caller's own id, because an
 * administrator who suspends or demotes themselves has locked themselves out of
 * the only surface that could undo it. Disabling the buttons here just avoids
 * offering an action that cannot work; it is not what makes the rule true.
 */
const SELF_GUARD_MESSAGE =
  'You cannot change your own account status or role. Ask another administrator.';

/** The statuses an operator may set, in the order the buttons appear. */
const SETTABLE_STATUSES: readonly AdminUserStatusUpdate[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];

const STATUS_ACTIONS: Record<
  AdminUserStatusUpdate,
  { verb: string; done: string; destructive: boolean }
> = {
  ACTIVE: { verb: 'Reinstate', done: 'Account is now active', destructive: false },
  SUSPENDED: { verb: 'Suspend', done: 'Account suspended', destructive: true },
  DEACTIVATED: { verb: 'Deactivate', done: 'Account deactivated', destructive: true },
};

/**
 * The verb for setting `target`, read against where the account stands now.
 *
 * "Reinstate" is right for an account somebody locked and plainly wrong for one
 * that has never been active — an invitation nobody accepted is not being put
 * back to anything. The two destructive verbs need no such care: an account can
 * be suspended from any standing and the word means the same each time.
 */
function statusVerb(target: AdminUserStatusUpdate, current: UserStatus): string {
  if (target !== 'ACTIVE') return STATUS_ACTIONS[target].verb;
  return current === 'INVITED' ? 'Activate' : 'Reinstate';
}

/**
 * What actually happens, in the words an operator needs before confirming.
 *
 * Written out rather than summarised as "this will suspend the user", because
 * the part people get wrong is the timing: the session is gone at once, not at
 * the next token expiry, and nothing is deleted at all.
 */
function statusConsequence(target: AdminUserStatusUpdate): string {
  switch (target) {
    case 'ACTIVE':
      return 'They will be able to sign in from their next attempt. No session is restored: if a suspension signed their devices out, they have to sign in again on each of them.';
    case 'SUSPENDED':
      return 'They are signed out everywhere the moment you confirm: the change and the revocation of every live refresh token happen in one transaction. The access token already in their browser stops working on its very next request. They cannot sign in again until somebody reinstates them. Nothing is deleted — the account, its memberships and everything it has done stay exactly as they are.';
    case 'DEACTIVATED':
      return 'The same lockout as a suspension, and just as reversible: signed out everywhere at once, no sign-in until somebody reinstates them, nothing deleted. Deactivated is the standing for an account that is finished with, where suspended is one under review — the difference is what the next operator reads, not what the account can do.';
  }
}

/**
 * The plain reading of what an administrator can do here.
 *
 * Deliberately not softened. Granting this is the single most consequential
 * action on the platform surface, and somebody clicking through the dialog
 * should have been told exactly what they are handing over.
 */
function roleConsequence(target: PlatformRole): string {
  return target === 'ADMIN'
    ? 'An administrator can read every workspace on this deployment — its settings, its members, its counts — and every account on it, including this register and the platform audit log. They can suspend either a workspace or an account. That is the whole platform, not a workspace within it. It does not extend to any workspace’s customers, appointments or notes: the admin API carries no field for those.'
    : 'They lose the platform surface entirely: the workspace directory, this register, the audit log and the health screen. Their own workspace memberships are untouched and they keep signing in exactly as before. The server refuses this change when it would leave the platform with no active administrator.';
}

/**
 * Workspace lifecycle pills, for the memberships table.
 *
 * Suspended is amber rather than red: it is a reversible administrative
 * decision about a workspace, not a fault in it.
 */
const WORKSPACE_STATUS_TONES: Record<AdminWorkspaceStatus, BadgeTone> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  ARCHIVED: 'neutral',
};

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

function DetailSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <span className="mf-sr-only">Loading account</span>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 w-full lg:col-span-2" />
        <Skeleton className="h-64 w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export default function AdminUserDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const userId = params.id ?? '';
  const { user: signedInUser } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [pendingStatus, setPendingStatus] = useState<AdminUserStatusUpdate | null>(null);
  const [pendingRole, setPendingRole] = useState<PlatformRole | null>(null);

  /*
   * The operator's own clock. Every timestamp on this page belongs to the
   * platform rather than to a workspace — when somebody last signed in, when
   * their lockout expires — and an operator moving between accounts needs one
   * consistent clock rather than a different one per workspace the person
   * happens to belong to. `useAuth().user` has no timezone field, so the
   * browser's zone is the only honest answer.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const userQuery = useQuery({
    queryKey: adminKeys.user(userId),
    queryFn: () => fetchAdminUser(userId),
  });

  const account = userQuery.data;
  const isSelf = account !== undefined && signedInUser !== null && account.id === signedInUser.id;

  /**
   * Writes the answer straight into the cache, then invalidates the surface.
   *
   * Both PATCHes answer with the whole detail record, so seeding it means the
   * screen shows the new standing without a second round trip. The broad
   * invalidation afterwards is what catches everything that counted this
   * account — the register, the overview's admin and status tallies, the audit
   * log the change just wrote a row into. It costs one redundant refetch of the
   * record just seeded, which is a fair price for never leaving a stale count
   * on another screen.
   */
  const applyDetail = (detail: AdminUserDetail): void => {
    queryClient.setQueryData(adminKeys.user(detail.id), detail);
    void queryClient.invalidateQueries({ queryKey: adminKeys.root });
  };

  const statusMutation = useMutation<AdminUserDetail, unknown, AdminUserStatusUpdate>({
    mutationFn: (status) => updateAdminUserStatus(userId, status),
    onSuccess: (detail, status) => {
      applyDetail(detail);
      setPendingStatus(null);
      toast({ tone: 'success', title: STATUS_ACTIONS[status].done });
    },
    onError: (error) => {
      setPendingStatus(null);
      toast({
        tone: 'error',
        title: 'Could not change this account',
        // A 409 here is the server refusing a change to the caller's own
        // account, and it says so in a sentence worth reading. Replacing it
        // with "something went wrong" would hide the only useful part.
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const roleMutation = useMutation<AdminUserDetail, unknown, PlatformRole>({
    mutationFn: (platformRole) => updateAdminPlatformRole(userId, platformRole),
    onSuccess: (detail, platformRole) => {
      applyDetail(detail);
      setPendingRole(null);
      toast({
        tone: 'success',
        title:
          platformRole === 'ADMIN'
            ? 'Administrator access granted'
            : 'Administrator access revoked',
      });
    },
    onError: (error) => {
      setPendingRole(null);
      toast({
        tone: 'error',
        title: 'Could not change the platform role',
        // This is where the last-administrator refusal lands. The client cannot
        // pre-empt it — it depends on how many other active admins exist, which
        // this screen has not counted — so the server's message is the answer.
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const heading = account?.fullName ?? 'Account';

  /*
   * A lockout is only real while it is in the future. `lockedUntil` is left
   * behind by the login throttle and is not cleared when it expires, so
   * rendering it unconditionally would show a live padlock over an account that
   * has been able to sign in for a fortnight — and that is a support call about
   * a problem nobody has.
   */
  const lockedUntilActive =
    account?.lockedUntil !== null &&
    account?.lockedUntil !== undefined &&
    DateTime.fromISO(account.lockedUntil) > DateTime.now();

  return (
    <>
      <PageHeader
        title={heading}
        description={account?.email}
        breadcrumbs={[
          { label: 'Platform', to: '/admin' },
          { label: 'Users', to: '/admin/users' },
          { label: heading },
        ]}
      >
        {account ? (
          <div className="flex flex-wrap items-center gap-2">
            <PlatformRoleBadge role={account.platformRole} />
            <AccountStatusBadge status={account.status} />
            {lockedUntilActive ? (
              <Badge tone="warning">
                <Lock className="size-3.5" aria-hidden="true" />
                Locked out
              </Badge>
            ) : null}
          </div>
        ) : null}
      </PageHeader>

      {userQuery.isError ? (
        <Card>
          <ErrorState error={userQuery.error} onRetry={() => void userQuery.refetch()} />
        </Card>
      ) : account === undefined ? (
        <DetailSkeleton />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                as="h2"
                title="Account"
                description="What this person signs in with, and what the login throttle currently thinks of them."
              />
              <CardBody className="flex flex-col gap-5">
                <dl className="grid gap-5 sm:grid-cols-2">
                  <DetailRow label="Email">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-all">{account.email}</span>
                      <Badge tone={account.emailVerified ? 'success' : 'neutral'} dot>
                        {account.emailVerified ? 'Verified' : 'Unverified'}
                      </Badge>
                    </span>
                  </DetailRow>
                  <DetailRow label="Phone">{account.phone ?? 'Not given'}</DetailRow>
                  <DetailRow label="Their timezone">{formatZoneLabel(account.timezone)}</DetailRow>
                  <DetailRow label="Locale">{account.locale}</DetailRow>
                  <DetailRow label="Joined">
                    <span className="tabular-nums">{formatDate(account.createdAt, zone)}</span>
                  </DetailRow>
                  <DetailRow label="Last seen">
                    {account.lastLoginAt ? formatRelative(account.lastLoginAt, zone) : 'Never'}
                  </DetailRow>
                  <DetailRow label="Failed sign-ins">
                    <span className="tabular-nums">{formatNumber(account.failedLoginCount)}</span>
                  </DetailRow>
                  <DetailRow label="Workspaces">
                    <span className="tabular-nums">
                      {formatNumber(account.workspaceCount)} joined ·{' '}
                      {formatNumber(account.ownedWorkspaceCount)} owned
                    </span>
                  </DetailRow>
                </dl>

                {lockedUntilActive && account.lockedUntil ? (
                  <p className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-text">
                    <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>
                      Locked until {formatDateTime(account.lockedUntil, zone)}. This is the login
                      throttle after repeated failed attempts, not a decision anybody took — it
                      clears itself, and it is the usual reason an account that reads as active
                      cannot sign in.
                    </span>
                  </p>
                ) : null}

                <p className="text-xs text-fg-muted">
                  Times are shown in your own timezone ({zone}), not this account&rsquo;s.
                </p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader as="h2" title="Sessions" description="Where this account is signed in." />
              <CardBody className="flex flex-col gap-3">
                <p className="text-3xl font-semibold tabular-nums text-fg">
                  {formatNumber(account.activeSessionCount)}
                </p>
                <p className="text-sm leading-relaxed text-fg-secondary">
                  Live refresh-token families — one per device that is still signed in, so three
                  means three devices rather than three tabs. Suspending or deactivating the account
                  revokes all of them at once.
                </p>
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                as="h2"
                title="Account status"
                description="Whether this person can sign in. Nothing here deletes anything."
              />
              <CardBody className="flex flex-col gap-4">
                <p className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                  Currently
                  <AccountStatusBadge status={account.status} />
                </p>

                {isSelf ? (
                  <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
                    {SELF_GUARD_MESSAGE}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {SETTABLE_STATUSES.filter((target) => target !== account.status).map((target) => (
                    <Button
                      key={target}
                      variant={STATUS_ACTIONS[target].destructive ? 'danger' : 'primary'}
                      disabled={isSelf || statusMutation.isPending}
                      onClick={() => setPendingStatus(target)}
                    >
                      {statusVerb(target, account.status)}
                    </Button>
                  ))}
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                as="h2"
                title="Platform role"
                description="Whether this account administers the deployment or only uses it."
              />
              <CardBody className="flex flex-col gap-4">
                <p className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                  Currently
                  <PlatformRoleBadge role={account.platformRole} />
                </p>

                <p className="text-sm leading-relaxed text-fg-secondary">
                  {account.platformRole === 'ADMIN'
                    ? 'They can read every workspace and every account on this deployment, and can suspend either.'
                    : 'They can reach only the workspaces they belong to, with whatever their role in each one allows.'}
                </p>

                {isSelf ? (
                  <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
                    {SELF_GUARD_MESSAGE}
                  </p>
                ) : null}

                <div>
                  <Button
                    variant={account.platformRole === 'ADMIN' ? 'secondary' : 'primary'}
                    disabled={isSelf || roleMutation.isPending}
                    leadingIcon={
                      account.platformRole === 'ADMIN' ? (
                        <ShieldOff className="size-4" aria-hidden="true" />
                      ) : (
                        <ShieldCheck className="size-4" aria-hidden="true" />
                      )
                    }
                    onClick={() =>
                      setPendingRole(account.platformRole === 'ADMIN' ? 'USER' : 'ADMIN')
                    }
                  >
                    {account.platformRole === 'ADMIN'
                      ? 'Revoke administrator'
                      : 'Make administrator'}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              as="h2"
              title="Workspaces"
              description="Every workspace this account belongs to, with the role and standing it holds in each. Nothing from inside those workspaces appears here: the admin API carries membership, never contents."
            />
            {account.memberships.length === 0 ? (
              <EmptyState
                icon={<Building2 className="size-6" aria-hidden="true" />}
                title="No workspaces"
                description="This account belongs to none, which is normal for an operator or support account, and for somebody who registered and never finished setting up."
              />
            ) : (
              <TableContainer>
                <Table caption="Workspaces this account belongs to, with its role and standing in each.">
                  <THead>
                    <Tr>
                      <Th>Workspace</Th>
                      <Th>Workspace status</Th>
                      <Th>Role</Th>
                      <Th>Membership</Th>
                      <Th>Joined</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {account.memberships.map((membership) => (
                      <Tr key={membership.membershipId}>
                        <Td>
                          <Link
                            to={`/admin/workspaces/${membership.businessId}`}
                            className="block truncate rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            {membership.businessName}
                          </Link>
                          <span className="block truncate text-xs text-fg-muted">
                            /{membership.businessSlug}
                          </span>
                        </Td>
                        <Td>
                          <Badge tone={WORKSPACE_STATUS_TONES[membership.businessStatus]} dot>
                            {humanizeEnum(membership.businessStatus)}
                          </Badge>
                        </Td>
                        <Td>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm text-fg">{membership.roleName}</span>
                            {membership.isOwner ? <Badge tone="accent">Owner</Badge> : null}
                          </span>
                        </Td>
                        <Td>
                          <MembershipStatusBadge status={membership.status} />
                        </Td>
                        <Td>
                          <span className="text-sm tabular-nums text-fg-secondary">
                            {membership.joinedAt ? formatDate(membership.joinedAt, zone) : '—'}
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableContainer>
            )}
          </Card>

          <ConfirmDialog
            open={pendingStatus !== null}
            onCancel={() => setPendingStatus(null)}
            onConfirm={() => {
              if (pendingStatus !== null) statusMutation.mutate(pendingStatus);
            }}
            title={
              pendingStatus !== null
                ? `${statusVerb(pendingStatus, account.status)} ${account.fullName}?`
                : ''
            }
            description={
              pendingStatus !== null ? (
                <span className="flex flex-col gap-2">
                  <span>{statusConsequence(pendingStatus)}</span>
                  {/*
                   * Owning a workspace and having an account are separate
                   * things, and confusing them is how somebody suspends a
                   * person expecting a clinic's booking page to go dark.
                   */}
                  {pendingStatus !== 'ACTIVE' && account.ownedWorkspaceCount > 0 ? (
                    <span>
                      This person owns {formatNumber(account.ownedWorkspaceCount)}{' '}
                      {account.ownedWorkspaceCount === 1 ? 'workspace' : 'workspaces'}. Locking
                      their account does not suspend those workspaces — the booking pages stay up,
                      bookings keep arriving and the rest of their team keeps working. Suspend a
                      workspace from its own page if that is what you mean to do.
                    </span>
                  ) : null}
                </span>
              ) : (
                ''
              )
            }
            confirmLabel={
              pendingStatus !== null ? `${statusVerb(pendingStatus, account.status)} account` : ''
            }
            cancelLabel="Leave it"
            destructive={pendingStatus !== null && STATUS_ACTIONS[pendingStatus].destructive}
            loading={statusMutation.isPending}
          />

          <ConfirmDialog
            open={pendingRole !== null}
            onCancel={() => setPendingRole(null)}
            onConfirm={() => {
              if (pendingRole !== null) roleMutation.mutate(pendingRole);
            }}
            title={
              pendingRole === 'ADMIN'
                ? `Make ${account.fullName} a platform administrator?`
                : `Revoke ${account.fullName}'s administrator access?`
            }
            description={pendingRole !== null ? roleConsequence(pendingRole) : ''}
            confirmLabel={pendingRole === 'ADMIN' ? 'Grant administrator' : 'Revoke administrator'}
            cancelLabel="Leave it"
            destructive={pendingRole === 'USER'}
            loading={roleMutation.isPending}
          />
        </>
      )}
    </>
  );
}
