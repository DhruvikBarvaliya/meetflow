import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  CalendarCheck2,
  Contact,
  MapPin,
  ScrollText,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  AppointmentStatusBadge,
  DataState,
  MembershipStatusBadge,
  StatTile,
  StatTileGrid,
} from '@/components/owner';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  SkeletonText,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Textarea,
  Th,
  Tr,
  buttonStyles,
  useToast,
  type ButtonVariant,
} from '@/components/ui';
import { isApiError } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import {
  browserTimezone,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRatioAsPercent,
  formatRelative,
  formatZoneLabel,
  humanizeEnum,
} from '@/lib/format';
import type {
  AdminAppointmentStatusCount,
  AdminWorkspaceDetail,
  AdminWorkspaceStatus,
  AppointmentStatus,
} from '@/types/api';
import { fetchAdminWorkspace, updateAdminWorkspaceStatus } from './adminApi';
import { adminKeys } from './adminKeys';
import { WorkspaceStatusBadge } from './AdminWorkspacesPage';

/**
 * One workspace, seen from outside it.
 *
 * The operator reading this page holds no membership in the workspace it
 * describes, which is precisely why the page exists: the tenant shell can only
 * show you a workspace you belong to, and somebody has to be able to answer
 * "what is this account, and should it still be running" without joining it.
 *
 * That outside vantage point is also the constraint the page is built around.
 * Everything here is the workspace's *shape* — how many members, how many
 * services, how many bookings and in what states — and none of it is the
 * workspace's contents. There is no customer list, no diary and no note,
 * because `AdminWorkspaceDetail` has no field to carry one. A platform operator
 * has no business reading a clinic's patient list, and the response shape is
 * what enforces that rather than a filter somebody could forget to apply.
 *
 * The one consequential thing this page can do is change the workspace's
 * lifecycle status, and that is deliberately the most heavily worded section on
 * it. Suspending a workspace cuts off every member of a paying customer's team
 * within one request. Nothing about a small amber button says that, so the
 * dialog does.
 */

// ---------------------------------------------------------------------------
// Status actions
// ---------------------------------------------------------------------------

/**
 * One lifecycle transition, with everything the confirmation needs to explain
 * it.
 *
 * The copy lives in data rather than in three near-identical blocks of JSX so
 * that the consequences of suspending and of archiving cannot drift into saying
 * subtly different things about the same underlying behaviour.
 */
interface StatusAction {
  /** The status the workspace moves to. */
  target: AdminWorkspaceStatus;
  /** The button on the card. */
  label: string;
  variant: ButtonVariant;
  title: (workspaceName: string) => string;
  lead: string;
  /** Stated plainly, because none of these are obvious from the button. */
  consequences: string[];
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  toastTitle: string;
}

const SUSPEND: StatusAction = {
  target: 'SUSPENDED',
  label: 'Suspend workspace',
  variant: 'danger',
  title: (name) => `Suspend ${name}?`,
  lead: 'This takes effect immediately, for everyone.',
  consequences: [
    'Every member of the workspace loses access to the management API on their very next request.',
    'Its public booking pages stop accepting bookings.',
    'Nothing is deleted. Reinstating restores access in full.',
  ],
  confirmLabel: 'Suspend workspace',
  cancelLabel: 'Leave it active',
  destructive: true,
  toastTitle: 'Workspace suspended',
};

const ARCHIVE: StatusAction = {
  target: 'ARCHIVED',
  label: 'Archive workspace',
  variant: 'secondary',
  title: (name) => `Archive ${name}?`,
  lead: 'Archiving is how a workspace is retired. It takes effect immediately.',
  consequences: [
    'Every member loses access to the management API on their very next request.',
    'Its public booking pages stop accepting bookings.',
    'Nothing is deleted, and its records stay readable from this surface.',
    'Reinstating restores access in full.',
  ],
  confirmLabel: 'Archive workspace',
  cancelLabel: 'Leave it as it is',
  destructive: true,
  toastTitle: 'Workspace archived',
};

const REINSTATE: StatusAction = {
  target: 'ACTIVE',
  label: 'Reinstate workspace',
  variant: 'primary',
  title: (name) => `Reinstate ${name}?`,
  lead: 'This takes effect immediately, for everyone.',
  consequences: [
    'Every member gets their access back on their next request.',
    'Its public booking pages start accepting bookings again.',
    'Nothing that happened while it was out of service is lost.',
  ],
  confirmLabel: 'Reinstate workspace',
  cancelLabel: 'Leave it as it is',
  destructive: false,
  toastTitle: 'Workspace reinstated',
};

/**
 * What can be done from where.
 *
 * A suspended workspace can be reinstated or retired for good; an archived one
 * can only come back. Offering "suspend" next to an already suspended workspace
 * would be a button that does nothing, and an operator who clicks it learns to
 * distrust the whole panel.
 */
const ACTIONS_BY_STATUS: Record<AdminWorkspaceStatus, StatusAction[]> = {
  ACTIVE: [SUSPEND],
  SUSPENDED: [REINSTATE, ARCHIVE],
  ARCHIVED: [REINSTATE],
};

/** What the current status means, said in terms of what people can and cannot do. */
const STATUS_MEANING: Record<AdminWorkspaceStatus, string> = {
  ACTIVE:
    'Members can sign in and work, and the public booking pages are taking bookings as normal.',
  SUSPENDED:
    'Members are refused by the management API and the public booking pages take no bookings. Nothing has been deleted.',
  ARCHIVED:
    'Retired. Members are refused and the booking pages are closed. Its records are still here and still readable from this surface.',
};

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * Fills of the appointment-status bars.
 *
 * The tones mirror `components/owner/StatusBadge.tsx` deliberately: the pill
 * and the bar sit on the same row, and a booking state that is amber in one and
 * green in the other would be read as two different things. That module maps
 * statuses to `Badge` tones rather than to fill classes, which is why the
 * mapping is restated here instead of imported.
 */
const APPOINTMENT_BAR_FILLS: Record<AppointmentStatus, string> = {
  PENDING: 'bg-warning',
  CONFIRMED: 'bg-success',
  IN_PROGRESS: 'bg-info',
  COMPLETED: 'bg-brand',
  CANCELLED: 'bg-border-strong',
  NO_SHOW: 'bg-danger',
  REJECTED: 'bg-danger',
  RESCHEDULED: 'bg-info',
};

/**
 * `appointment.cancelled` becomes `Appointment cancelled`.
 *
 * Audit actions are dotted rather than SCREAMING_SNAKE, so `humanizeEnum` on
 * its own would leave a full stop sitting in the middle of the phrase.
 */
function humaniseAction(action: string): string {
  return humanizeEnum(action.replace(/\./g, ' '));
}

/**
 * A field the workspace has not filled in renders an em dash.
 *
 * Never the word "null" and never an empty cell: the first is a bug report
 * waiting to be filed, and the second cannot be told apart from a field this
 * page forgot to render.
 */
function orDash(value: string | null): ReactNode {
  return value === null || value.trim() === '' ? <span className="text-fg-muted">—</span> : value;
}

function Detail({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * The mix of appointment states, as proportions of the workspace's lifetime
 * total.
 *
 * A share is worth more than a count on this screen. "Four hundred cancelled"
 * means nothing without the denominator, whereas "31% cancelled" is a finding
 * an operator can act on — and both are shown, because the percentage of a
 * small workspace is noisy and the count is what says so.
 */
function StatusDistribution({ rows }: { rows: AdminAppointmentStatusCount[] }): JSX.Element {
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  if (total === 0) {
    return (
      <EmptyState
        icon={<CalendarCheck2 className="size-6" aria-hidden="true" />}
        title="No bookings yet"
        description="This workspace has never taken an appointment, so there is no mix to show."
      />
    );
  }

  // Largest share first. The API groups by status and returns them in whatever
  // order the group came back in, which is not an order worth showing anybody.
  const ordered = [...rows].sort((a, b) => b.count - a.count);

  return (
    <ul className="flex flex-col gap-4">
      {ordered.map((row) => {
        const share = row.count / total;
        return (
          <li key={row.status} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <AppointmentStatusBadge status={row.status} />
              <p className="text-sm tabular-nums text-fg-secondary">
                {formatNumber(row.count)}{' '}
                <span className="text-fg-muted">({formatRatioAsPercent(share)})</span>
              </p>
            </div>
            {/* Decorative: the figure beside it already carries the number, so
                a screen reader hearing the bar as well would hear it twice. */}
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
              aria-hidden="true"
            >
              <div
                className={cn('h-full rounded-full', APPOINTMENT_BAR_FILLS[row.status])}
                style={{ width: `${Math.max(share * 100, 1)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminWorkspaceDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  /*
   * The route cannot match without an `:id` segment, but `useParams` types every
   * segment as optional, so this falls back rather than asserting. An empty id
   * asks the API for `/admin/workspaces/`, which answers 404 — the same
   * not-found state a deleted workspace lands on, which is the right outcome.
   */
  const workspaceId = params.id ?? '';

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reasonFieldId = useId();

  const [pending, setPending] = useState<StatusAction | null>(null);
  const [reason, setReason] = useState('');

  /*
   * The operator's own clock, not the workspace's.
   *
   * Everywhere else in MeetFlow a time is rendered in the workspace timezone,
   * because a 9am appointment means 9am where the clinic is. Here the reader is
   * an operator moving between workspaces all afternoon, and every date on the
   * page is administrative — when the account was created, when somebody joined,
   * when an audit row was written. Those are only comparable against one clock,
   * and `useAuth().user` carries no timezone field, so the browser's zone is the
   * only honest source for it. The workspace's own zone is shown as a *fact*
   * about the workspace, in the profile below, rather than used to render this
   * page.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const detailQuery = useQuery({
    queryKey: adminKeys.workspace(workspaceId),
    queryFn: () => fetchAdminWorkspace(workspaceId),
  });

  const workspace = detailQuery.data;

  const statusMutation = useMutation<
    AdminWorkspaceDetail,
    unknown,
    { action: StatusAction; reason: string }
  >({
    mutationFn: (variables) =>
      updateAdminWorkspaceStatus(workspaceId, {
        status: variables.action.target,
        // `updateAdminWorkspaceStatus` drops a blank reason entirely: the
        // server schema is strict with a minimum length, so sending an empty
        // string would be a validation error rather than "no reason given".
        reason: variables.reason,
      }),
    onSuccess: (updated, variables) => {
      // The PATCH answers the whole detail record, so the screen can repaint
      // from the response rather than waiting on a round trip.
      queryClient.setQueryData(adminKeys.workspace(workspaceId), updated);
      /*
       * Then invalidate anyway, and invalidate the list with it. The prefix
       * covers both `['admin','workspaces','detail',id]` and every cached page
       * of `['admin','workspaces','list',scope]`, whose status column and
       * ordering this change can move. The extra detail refetch is one request
       * and it is what stops the screen sitting on a response that raced
       * another operator's change.
       */
      void queryClient.invalidateQueries({ queryKey: [...adminKeys.root, 'workspaces'] });
      // The overview's workspace tiles count exactly this. Left stale, the
      // landing screen would report a suspension that has already happened as
      // not having happened.
      void queryClient.invalidateQueries({ queryKey: adminKeys.overview() });

      toast({
        tone: 'success',
        title: variables.action.toastTitle,
        description: `${updated.name} is now ${humanizeEnum(updated.status).toLowerCase()}. The change is in the audit trail.`,
      });
      setPending(null);
      setReason('');
    },
    onError: (error) => {
      // The dialog stays open so the operator can correct and retry. The
      // server's messages on this surface are written for people — a refusal
      // says which rule refused — so it is shown verbatim rather than replaced
      // with a generic apology.
      toast({
        tone: 'error',
        title: 'Could not change the status',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const openAction = (action: StatusAction): void => {
    setReason('');
    setPending(action);
  };

  const closeAction = (): void => {
    if (statusMutation.isPending) return;
    setPending(null);
    setReason('');
  };

  const breadcrumbs = [
    { label: 'Workspaces', to: '/admin/workspaces' },
    { label: workspace?.name ?? 'Workspace' },
  ];

  if (detailQuery.isError) {
    return (
      <>
        <PageHeader title="Workspace" breadcrumbs={breadcrumbs} />
        <Card>
          <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={workspace?.name ?? 'Workspace'}
        breadcrumbs={breadcrumbs}
        description={
          workspace ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">/{workspace.slug}</span>
              <WorkspaceStatusBadge status={workspace.status} />
            </span>
          ) : undefined
        }
      />

      <StatTileGrid columns={3}>
        <StatTile
          label="Members"
          value={formatNumber(workspace?.counts.members ?? 0)}
          icon={UsersRound}
          isLoading={detailQuery.isPending}
          caption="People with a membership in this workspace"
        />
        <StatTile
          label="Staff"
          value={formatNumber(workspace?.counts.staff ?? 0)}
          icon={Briefcase}
          isLoading={detailQuery.isPending}
          caption="Bookable providers on its team"
        />
        <StatTile
          label="Services"
          value={formatNumber(workspace?.counts.services ?? 0)}
          icon={Sparkles}
          isLoading={detailQuery.isPending}
          caption="Things a customer can book"
        />
        <StatTile
          label="Locations"
          value={formatNumber(workspace?.counts.locations ?? 0)}
          icon={MapPin}
          isLoading={detailQuery.isPending}
          caption="Places it works from"
        />
        <StatTile
          label="Appointments"
          value={formatNumber(workspace?.counts.appointments ?? 0)}
          icon={CalendarCheck2}
          isLoading={detailQuery.isPending}
          caption="Every booking ever taken, cancellations included"
        />
        <StatTile
          label="Customers"
          value={formatNumber(workspace?.counts.customers ?? 0)}
          icon={Contact}
          isLoading={detailQuery.isPending}
          caption="A count only — this surface exposes no customer record"
        />
      </StatTileGrid>

      <Card>
        <CardHeader
          as="h2"
          title="Profile"
          description="What the workspace has told the platform about itself."
        />
        <CardBody>
          {detailQuery.isPending || !workspace ? (
            <SkeletonText lines={6} />
          ) : (
            <div className="flex flex-col gap-5">
              <dl className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                <Detail label="Owner">
                  {workspace.owner ? (
                    <span className="flex flex-col gap-0.5">
                      <Link
                        to={`/admin/users/${workspace.owner.id}`}
                        className="rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {`${workspace.owner.firstName} ${workspace.owner.lastName}`.trim()}
                      </Link>
                      <span className="truncate text-xs text-fg-muted">
                        {workspace.owner.email}
                      </span>
                    </span>
                  ) : (
                    // Not a missing field: the owning account has been
                    // soft-deleted out from under the workspace, which is
                    // exactly the sort of thing an operator opens this page to
                    // find, so it says so rather than showing a dash.
                    <span className="text-fg-muted">No owner account</span>
                  )}
                </Detail>
                <Detail label="Legal name">{orDash(workspace.legalName)}</Detail>
                <Detail label="Industry">
                  {workspace.industry === null ? orDash(null) : humanizeEnum(workspace.industry)}
                </Detail>
                <Detail label="Timezone">{formatZoneLabel(workspace.timezone)}</Detail>
                <Detail label="Currency">{workspace.currency}</Detail>
                <Detail label="Locale">{workspace.locale}</Detail>
                <Detail label="Support email">
                  {workspace.supportEmail === null ? (
                    orDash(null)
                  ) : (
                    <a
                      href={`mailto:${workspace.supportEmail}`}
                      className="rounded-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {workspace.supportEmail}
                    </a>
                  )}
                </Detail>
                <Detail label="Support phone">
                  {workspace.supportPhone === null ? (
                    orDash(null)
                  ) : (
                    <a
                      href={`tel:${workspace.supportPhone}`}
                      className="rounded-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {workspace.supportPhone}
                    </a>
                  )}
                </Detail>
                <Detail label="Website">
                  {workspace.websiteUrl === null ? (
                    orDash(null)
                  ) : (
                    // `noreferrer` as well as `noopener`: this is a URL a tenant
                    // typed, and the admin panel's address is not something to
                    // hand to it in a Referer header.
                    <a
                      href={workspace.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {workspace.websiteUrl}
                    </a>
                  )}
                </Detail>
                <Detail label="Created">
                  <span className="tabular-nums">{formatDate(workspace.createdAt, zone)}</span>
                  <span className="text-fg-muted">
                    {` · ${formatRelative(workspace.createdAt, zone)}`}
                  </span>
                </Detail>
                <Detail label="Last booking">
                  {workspace.lastAppointmentAt === null ? (
                    <span className="text-fg-muted">Never taken a booking</span>
                  ) : (
                    <>
                      <span className="tabular-nums">
                        {formatDate(workspace.lastAppointmentAt, zone)}
                      </span>
                      <span className="text-fg-muted">
                        {` · ${formatRelative(workspace.lastAppointmentAt, zone)}`}
                      </span>
                    </>
                  )}
                </Detail>
              </dl>

              {workspace.description !== null && workspace.description.trim() !== '' ? (
                <div className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                    Description
                  </h3>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-secondary">
                    {workspace.description}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader as="h2" title="Members" description="Who administers this workspace." />
          {/*
            One request feeds this whole page, and a failed one is handled above
            by returning the page-level error state. So no section below can be
            in an error of its own: `isError` is a constant here rather than a
            branch that could ever be taken.
          */}
          <DataState
            isPending={detailQuery.isPending}
            isError={false}
            error={null}
            onRetry={() => void detailQuery.refetch()}
            isEmpty={(workspace?.members.length ?? 0) === 0}
            rows={4}
            columns={4}
            empty={
              <EmptyState
                icon={<UsersRound className="size-6" aria-hidden="true" />}
                title="No members"
                description="Nobody holds a membership in this workspace. That normally means the owning account was removed."
              />
            }
          >
            <TableContainer className="rounded-none border-0 border-b">
              <Table caption="People who hold a membership in this workspace, with their role.">
                <THead>
                  <Tr>
                    <Th>Person</Th>
                    <Th>Role</Th>
                    <Th>Status</Th>
                    <Th>Joined</Th>
                  </Tr>
                </THead>
                <TBody>
                  {(workspace?.members ?? []).map((member) => (
                    <Tr key={member.membershipId}>
                      <Td>
                        <Link
                          to={`/admin/users/${member.user.id}`}
                          className="rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          {`${member.user.firstName} ${member.user.lastName}`.trim()}
                        </Link>
                        <span className="block truncate text-xs text-fg-muted">
                          {member.user.email}
                        </span>
                      </Td>
                      <Td>{member.roleName}</Td>
                      <Td>
                        <MembershipStatusBadge status={member.status} />
                      </Td>
                      <Td>
                        {member.joinedAt === null ? (
                          // Null while an invitation is outstanding — nobody has
                          // accepted yet, which is not the same as an unknown date.
                          <span className="text-fg-muted">Invitation outstanding</span>
                        ) : (
                          <time dateTime={member.joinedAt} className="tabular-nums">
                            {formatDate(member.joinedAt, zone)}
                          </time>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableContainer>
          </DataState>
          <CardBody>
            <p className="text-xs leading-relaxed text-fg-muted">
              Members, not customers. This surface can see who administers a workspace and never who
              books with it: the admin API carries no customer name, email address or appointment,
              so there is nothing on this page that could reveal one.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            as="h2"
            title="Appointment mix"
            description="Every booking this workspace has ever taken, by the state it ended up in."
          />
          <CardBody>
            {detailQuery.isPending || !workspace ? (
              <SkeletonText lines={5} />
            ) : (
              <StatusDistribution rows={workspace.appointmentsByStatus} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          as="h2"
          title="Recent activity"
          description="The last twenty audit rows written against this workspace, newest first."
          actions={
            /*
             * One link at the top rather than the same link repeated on twenty
             * rows: every row here belongs to this workspace, so a per-row link
             * would lead twenty times to the same filtered feed and read as if
             * each row had its own destination.
             */
            <Link
              to={`/admin/audit?businessId=${workspaceId}`}
              className={buttonStyles('secondary', 'sm')}
            >
              Full audit log
            </Link>
          }
        />
        <DataState
          isPending={detailQuery.isPending}
          isError={false}
          error={null}
          onRetry={() => void detailQuery.refetch()}
          isEmpty={(workspace?.recentActivity.length ?? 0) === 0}
          rows={5}
          columns={4}
          empty={
            <EmptyState
              icon={<ScrollText className="size-6" aria-hidden="true" />}
              title="Nothing recorded yet"
              description="No audited action has been taken in this workspace."
            />
          }
        >
          <TableContainer className="rounded-none border-0">
            <Table caption="The most recent audited actions taken in this workspace.">
              <THead>
                <Tr>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Actor</Th>
                  <Th>When</Th>
                </Tr>
              </THead>
              <TBody>
                {(workspace?.recentActivity ?? []).map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="font-medium text-fg">{humaniseAction(entry.action)}</Td>
                    <Td>{humanizeEnum(entry.entityType)}</Td>
                    <Td>
                      {/* Null only where there is no account to name — the
                          platform itself acting, not a person. */}
                      {entry.actorLabel ?? <span className="text-fg-muted">System</span>}
                    </Td>
                    <Td>
                      <time
                        dateTime={entry.createdAt}
                        title={formatDateTime(entry.createdAt, zone)}
                        className="whitespace-nowrap"
                      >
                        {formatRelative(entry.createdAt, zone)}
                      </time>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        </DataState>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="Workspace status"
          description="The lifecycle of the whole account. Every change here is recorded in the audit trail with the operator who made it."
        />
        <CardBody>
          {detailQuery.isPending || !workspace ? (
            <SkeletonText lines={3} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col items-start gap-2">
                <WorkspaceStatusBadge status={workspace.status} />
                <p className="max-w-2xl text-sm leading-relaxed text-fg-secondary">
                  {STATUS_MEANING[workspace.status]}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {ACTIONS_BY_STATUS[workspace.status].map((action) => (
                  <Button
                    key={action.target}
                    variant={action.variant}
                    onClick={() => openAction(action)}
                    disabled={statusMutation.isPending}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onCancel={closeAction}
        onConfirm={() => {
          if (pending) statusMutation.mutate({ action: pending, reason });
        }}
        title={pending && workspace ? pending.title(workspace.name) : ''}
        description={
          pending ? (
            <>
              <span className="block">{pending.lead}</span>

              {/*
                `ConfirmDialog` renders its description inside a paragraph, whose
                content model is phrasing content only — a real `<ul>` there would
                be invalid and the browser would split the paragraph around it.
                The ARIA roles give the list its semantics without the block
                elements, which is the trade-off worth making: an operator about
                to cut off a customer's whole team needs to hear these as a list.
              */}
              <span role="list" className="mt-3 flex flex-col gap-1.5">
                {pending.consequences.map((consequence) => (
                  <span key={consequence} role="listitem" className="flex gap-2">
                    <span aria-hidden="true" className="text-fg-muted">
                      ·
                    </span>
                    <span>{consequence}</span>
                  </span>
                ))}
              </span>

              <span className="mt-4 block">
                <label htmlFor={reasonFieldId} className="mb-1.5 block text-sm font-medium text-fg">
                  Reason (optional)
                </label>
                <Textarea
                  id={reasonFieldId}
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why this is being done"
                />
                <span className="mt-1.5 block text-xs text-fg-muted">
                  Recorded in the audit trail and nowhere else. Weeks later, this is the only thing
                  that will explain the decision.
                </span>
              </span>
            </>
          ) : null
        }
        confirmLabel={pending?.confirmLabel ?? 'Confirm'}
        cancelLabel={pending?.cancelLabel ?? 'Keep'}
        destructive={pending?.destructive ?? false}
        loading={statusMutation.isPending}
      />
    </>
  );
}
