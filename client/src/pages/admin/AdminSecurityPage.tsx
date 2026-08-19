import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { KeyRound, Lock, LogIn, RefreshCw, ShieldAlert, ShieldX } from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  DataState,
  FilterBar,
  FilterField,
  StatTile,
  StatTileGrid,
  type DateRange,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DatePicker,
  EmptyState,
  Select,
  Skeleton,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';
import { browserTimezone, formatDateTime, formatNumber, formatRatioAsPercent } from '@/lib/format';
import type { AdminAuditEntry, AdminAuditFilters, Page } from '@/types/api';
import { ADMIN_PAGE_SIZE, adminAuditScope, fetchAdminAuditLogs } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The platform's security signal, gathered into one place.
 *
 * Until now the only way to ask "is anybody being attacked" was to open one
 * account at a time — `lockedUntil` and `failedLoginCount` live on a single
 * user's detail page — or to remember the exact dotted verb and type it into
 * the audit filter. Neither is a question an operator can ask of the platform,
 * which is what this page is for.
 *
 * **Every figure on it is counted by the API, not by this page.** Each panel is
 * one `GET /admin/audit-logs` call filtered to one action, and the number shown
 * is that response's `meta.totalItems` — the same count the endpoint would give
 * anybody paging through the rows. Nothing here is sampled, extrapolated, or
 * inferred from the page in hand.
 *
 * **What the API cannot answer is stated on the page rather than left blank.**
 * There is no HTTP error rate here, no 429 view and no list of currently locked
 * accounts, because no endpoint reports any of the three — see
 * `UNANSWERABLE` below, which is rendered at the foot of the screen. An
 * operator must not read the absence of a rate-limit panel as the absence of
 * rate limiting; a security screen that lets someone conclude "nothing is
 * happening" from a figure it never had is worse than one that says so.
 */

/**
 * The verbs this page reads, sourced from `AuditActions` in
 * server/src/modules/audit/audit.service.ts.
 *
 * The filter is an exact match on the dotted verb, so a typo here is a panel
 * that reads zero rather than an error — which is exactly the failure mode this
 * page exists to avoid. When one of these changes on the server, that file is
 * where to check.
 */
const ACTIONS = {
  loginFailed: 'user.login_failed',
  loginBlocked: 'user.login_blocked',
  tokenReuse: 'user.token_reuse_detected',
  loginSucceeded: 'user.login_succeeded',
  resetRequested: 'user.password_reset_requested',
  resetCompleted: 'user.password_reset_completed',
  passwordChanged: 'user.password_changed',
  sessionsRevoked: 'user.logged_out_all',
} as const;

/**
 * How many merged rows the recent-events table shows.
 *
 * Capped at the admin page size, and that is a correctness constraint rather
 * than a layout one. Each signal is fetched as its own newest page, so the union
 * of those pages provably contains every row belonging in the newest N overall
 * — but only while N is no larger than one page. Past it the table would start
 * omitting rows it never fetched while still looking complete, so the ceiling is
 * taken from `ADMIN_PAGE_SIZE` rather than restated as a number that could drift
 * from it.
 */
const RECENT_LIMIT = Math.min(12, ADMIN_PAGE_SIZE);

type PresetKey = 'today' | '7d' | '30d' | '90d' | 'custom';

const PRESET_OPTIONS: Array<{ value: PresetKey; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' },
];

/**
 * Windows are whole **UTC** days, because that is how the endpoint cuts them.
 *
 * A preset resolved against the operator's own clock would name a day the
 * filter reads as a different one either side of midnight, and the count would
 * quietly cover a window nobody chose. The disclosure under the controls says
 * so rather than the page pretending the two clocks agree.
 */
function resolvePreset(preset: Exclude<PresetKey, 'custom'>): DateRange {
  const today = DateTime.utc().startOf('day');
  const days = preset === 'today' ? 1 : preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return {
    from: today.minus({ days: days - 1 }).toISODate() ?? '',
    to: today.toISODate() ?? '',
  };
}

// ---------------------------------------------------------------------------
// Reading one signal
// ---------------------------------------------------------------------------

type SignalQuery = UseQueryResult<Page<AdminAuditEntry>>;

/**
 * One action, over one window: its rows and, more importantly, its total.
 *
 * There is deliberately no `placeholderData` here, although every paged table
 * on this deployment has one. A table holding the previous page while the next
 * loads shows the same rows a moment longer; a stat tile holding the previous
 * *window's* count while a new window loads shows a real number attributed to
 * the wrong dates, which is precisely the confident-but-wrong figure a security
 * page must never print. Changing the range blanks the tiles to skeletons, and
 * that is the honest reading of "we do not know yet".
 */
function useSignal(action: string, range: DateRange): SignalQuery {
  const filters: AdminAuditFilters = {
    page: 1,
    businessId: '',
    action,
    entityType: '',
    from: range.from,
    to: range.to,
  };

  return useQuery({
    // The same object feeds the key and the query string, so a cache entry and
    // the request it caches cannot describe different filters.
    queryKey: adminKeys.auditLogs(adminAuditScope(filters)),
    queryFn: () => fetchAdminAuditLogs(filters),
  });
}

/** The count, or null while it is unknown or the request failed. */
function totalOf(query: SignalQuery): number | null {
  return query.data?.meta.totalItems ?? null;
}

/** A figure that has not arrived is a skeleton; one that failed is an em dash. */
function figureOf(query: SignalQuery): string {
  const total = totalOf(query);
  return total === null ? '—' : formatNumber(total);
}

// ---------------------------------------------------------------------------
// Metadata, read defensively
// ---------------------------------------------------------------------------

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The one useful sentence an entry's metadata carries, if it carries one.
 *
 * The shape varies by action and is written by whichever module recorded the
 * row, so every key is type-checked rather than cast. An unrecognised shape
 * yields null and the cell falls back to an em dash — the row is still a real
 * event, and dropping it because its detail was unfamiliar would be worse than
 * showing it without one.
 */
function detailOf(entry: AdminAuditEntry): string | null {
  const zone = browserTimezone();

  if (entry.action === ACTIONS.loginFailed) {
    if (readString(entry.metadata, 'reason') === 'unknown_account') {
      return 'No account with that address';
    }
    const attempts = readNumber(entry.metadata, 'failedAttempts');
    const lockedUntil = readString(entry.metadata, 'lockedUntil');
    if (attempts === null) return 'Wrong password';
    return lockedUntil === null
      ? `Wrong password · ${attempts} in a row`
      : `Wrong password · ${attempts} in a row, locked until ${formatDateTime(lockedUntil, zone)}`;
  }

  if (entry.action === ACTIONS.loginBlocked) {
    const lockedUntil = readString(entry.metadata, 'lockedUntil');
    return lockedUntil === null
      ? 'Account was locked at the time'
      : `Locked until ${formatDateTime(lockedUntil, zone)}`;
  }

  if (entry.action === ACTIONS.tokenReuse) {
    const revoked = readNumber(entry.metadata, 'sessionsRevoked');
    return revoked === null
      ? 'The whole token family was revoked'
      : `${formatNumber(revoked)} session${revoked === 1 ? '' : 's'} revoked`;
  }

  return null;
}

const SIGNAL_LABELS: Record<string, string> = {
  [ACTIONS.loginFailed]: 'Failed sign-in',
  [ACTIONS.loginBlocked]: 'Sign-in blocked',
  [ACTIONS.tokenReuse]: 'Token reuse',
};

/**
 * Colour carries severity, not frequency.
 *
 * A failed sign-in is grey because it is overwhelmingly a person mistyping
 * their own password, and a screen that shouts at the ordinary case teaches
 * people to ignore it. A refresh token presented twice is red because the API
 * treats it as theft and revokes the whole family on the spot.
 */
const SIGNAL_TONES: Record<string, BadgeTone> = {
  [ACTIONS.loginFailed]: 'neutral',
  [ACTIONS.loginBlocked]: 'warning',
  [ACTIONS.tokenReuse]: 'danger',
};

const UNANSWERABLE: Array<{ title: string; body: string }> = [
  {
    title: 'HTTP error rate',
    body: 'The API keeps no aggregate of responses by status, so there is no figure to read. Answering it needs a new admin endpoint reporting request counts by status code over a window; `/admin/health` reports dependency reachability and the notification backlog, and nothing about traffic.',
  },
  {
    title: 'Rate limiting',
    body: 'A throttled request is refused in middleware and writes no audit row, so a 429 leaves nothing behind for this surface to count. Answering it needs either an audit entry when a limit is exhausted, or an endpoint exposing the limiter counters Redis already holds.',
  },
  {
    title: 'Accounts locked right now',
    body: '`lockedUntil` and `failedLoginCount` are returned by `GET /admin/users/:id` but not by the list, and the list has no filter for either — so naming who is locked would mean opening every account in turn. Answering it needs those two fields on the user list row, or a lock filter on it.',
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminSecurityPage(): JSX.Element {
  const queryClient = useQueryClient();

  /*
   * The operator's own clock for rendering instants, matching the audit log and
   * the health screen. There is no workspace in play on this surface, and a
   * trail spanning fifty of them cannot be read against fifty clocks.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const [preset, setPreset] = useState<PresetKey>('7d');
  const [range, setRange] = useState<DateRange>(() => resolvePreset('7d'));

  const failed = useSignal(ACTIONS.loginFailed, range);
  const blocked = useSignal(ACTIONS.loginBlocked, range);
  const reuse = useSignal(ACTIONS.tokenReuse, range);
  const succeeded = useSignal(ACTIONS.loginSucceeded, range);

  const resetRequested = useSignal(ACTIONS.resetRequested, range);
  const resetCompleted = useSignal(ACTIONS.resetCompleted, range);
  const passwordChanged = useSignal(ACTIONS.passwordChanged, range);
  const sessionsRevoked = useSignal(ACTIONS.sessionsRevoked, range);

  const failedTotal = totalOf(failed);
  const succeededTotal = totalOf(succeeded);

  /*
   * The share of sign-in attempts that failed.
   *
   * Both halves have to be present: a rate computed from one arrived count and
   * one missing one would read as a real proportion of a denominator this page
   * never saw. A window with no attempts at all has no rate rather than a rate
   * of zero, and says so.
   */
  const failureRate = useMemo<string | null>(() => {
    if (failedTotal === null || succeededTotal === null) return null;
    const attempts = failedTotal + succeededTotal;
    if (attempts === 0) return null;
    return `${formatRatioAsPercent(failedTotal / attempts)} of ${formatNumber(attempts)} attempts`;
  }, [failedTotal, succeededTotal]);

  /*
   * The newest twelve across the three signals.
   *
   * Each query returns its own action's newest page, so the union of the three
   * contains every row that could belong in the newest twelve — see
   * RECENT_LIMIT. Ordering is by parsed instant rather than by string: these
   * arrive as UTC and would sort lexicographically today, but that is a
   * property of the serialiser rather than of the contract.
   */
  const recentRows = useMemo(() => {
    const rows = [
      ...(failed.data?.items ?? []),
      ...(blocked.data?.items ?? []),
      ...(reuse.data?.items ?? []),
    ];
    rows.sort(
      (a, b) => DateTime.fromISO(b.createdAt).toMillis() - DateTime.fromISO(a.createdAt).toMillis(),
    );
    return rows.slice(0, RECENT_LIMIT);
  }, [failed.data, blocked.data, reuse.data]);

  const recentPending = failed.isPending || blocked.isPending || reuse.isPending;
  const recentError = failed.isError || blocked.isError || reuse.isError;
  const recentErrorObject = failed.error ?? blocked.error ?? reuse.error;

  const applyPreset = (next: PresetKey): void => {
    setPreset(next);
    if (next !== 'custom') setRange(resolvePreset(next));
  };

  const auditLink = (action: string): string =>
    `/admin/audit?action=${encodeURIComponent(action)}&from=${range.from}&to=${range.to}`;

  return (
    <>
      <PageHeader
        title="Security"
        description="Authentication signal across every workspace on this deployment, counted from the audit trail. Each figure is the endpoint's own total for one action over the window below."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: [...adminKeys.root, 'audit-logs'] })
            }
            leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            Refresh
          </Button>
        }
      >
        <FilterBar label="Window">
          <FilterField label="Period">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={preset}
                options={PRESET_OPTIONS}
                onChange={(event) => applyPreset(event.target.value as PresetKey)}
              />
            )}
          </FilterField>
          <FilterField label="From">
            {({ id }) => (
              <DatePicker
                id={id}
                value={range.from}
                timezone="UTC"
                max={range.to}
                onChange={(from) => {
                  setPreset('custom');
                  setRange((current) => ({ ...current, from }));
                }}
              />
            )}
          </FilterField>
          <FilterField label="To">
            {({ id }) => (
              <DatePicker
                id={id}
                value={range.to}
                timezone="UTC"
                min={range.from}
                onChange={(to) => {
                  setPreset('custom');
                  setRange((current) => ({ ...current, to }));
                }}
              />
            )}
          </FilterField>
        </FilterBar>

        <p className="text-xs leading-relaxed text-fg-muted">
          The window is inclusive at both ends and cut into whole UTC days, which is how the trail
          is stored. Times in the table are shown in your own zone ({zone}).
        </p>
      </PageHeader>

      <StatTileGrid>
        <StatTile
          label="Failed sign-ins"
          icon={ShieldAlert}
          value={figureOf(failed)}
          isLoading={failed.isPending}
          {...(failureRate === null ? {} : { detail: failureRate })}
          caption={
            <>
              Wrong password, or no account with that address.{' '}
              <TrailLink to={auditLink(ACTIONS.loginFailed)} label="See them all" />
            </>
          }
        />
        <StatTile
          label="Sign-ins blocked"
          icon={Lock}
          /* Amber only once there is something to be amber about. */
          tone={blocked.data && blocked.data.meta.totalItems > 0 ? 'attention' : 'default'}
          value={figureOf(blocked)}
          isLoading={blocked.isPending}
          caption={
            <>
              Attempts on an account the lockout ladder had already closed.{' '}
              <TrailLink to={auditLink(ACTIONS.loginBlocked)} label="See them all" />
            </>
          }
        />
        <StatTile
          label="Token reuse detected"
          icon={ShieldX}
          tone={reuse.data && reuse.data.meta.totalItems > 0 ? 'negative' : 'default'}
          value={figureOf(reuse)}
          isLoading={reuse.isPending}
          caption={
            <>
              A refresh token presented twice. The API treats this as theft and revokes the whole
              family. <TrailLink to={auditLink(ACTIONS.tokenReuse)} label="See them all" />
            </>
          }
        />
        <StatTile
          label="Successful sign-ins"
          icon={LogIn}
          value={figureOf(succeeded)}
          isLoading={succeeded.isPending}
          caption="The denominator behind the failure rate, and the baseline the other three are read against."
        />
      </StatTileGrid>

      <Card>
        <CardHeader
          as="h2"
          title="Recent security events"
          description={`The newest ${RECENT_LIMIT} failed sign-ins, blocked sign-ins and token reuse detections in this window, in order.`}
        />
        <DataState
          isPending={recentPending}
          isError={recentError}
          error={recentErrorObject}
          onRetry={() => {
            void failed.refetch();
            void blocked.refetch();
            void reuse.refetch();
          }}
          isEmpty={recentRows.length === 0}
          columns={5}
          empty={
            <EmptyState
              icon={<ShieldAlert className="size-6" aria-hidden="true" />}
              title="No security events in this window"
              description="Nobody failed a sign-in, hit a lockout or replayed a refresh token over these dates. Widen the window to look further back."
            />
          }
        >
          <TableContainer>
            <Table caption="Failed sign-ins, blocked sign-ins and token reuse detections">
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Signal</Th>
                  <Th>Account</Th>
                  <Th>IP address</Th>
                  <Th>Detail</Th>
                </Tr>
              </THead>
              <TBody>
                {recentRows.map((entry) => (
                  <Tr key={entry.id}>
                    <Td>
                      <span className="whitespace-nowrap tabular-nums text-fg-secondary">
                        {formatDateTime(entry.createdAt, zone)}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={SIGNAL_TONES[entry.action] ?? 'neutral'}>
                        {SIGNAL_LABELS[entry.action] ?? entry.action}
                      </Badge>
                    </Td>
                    <Td>
                      {/*
                       * The label is the address the attempt was made against,
                       * which for an unknown-account failure names no account at
                       * all — so it is shown as typed and only linked when the
                       * trail actually resolved it to one.
                       */}
                      {entry.actorUserId === null ? (
                        <span className="text-fg">{entry.actorLabel ?? '—'}</span>
                      ) : (
                        <Link
                          to={`/admin/users/${entry.actorUserId}`}
                          className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          {entry.actorLabel ?? 'This account'}
                        </Link>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-fg-secondary">
                        {entry.ipAddress ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">{detailOf(entry) ?? '—'}</span>
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
          title="Account recovery and sessions"
          description="A rise in any of these without a matching support request is worth reading beside the sign-in figures above."
        />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Figure
              label="Reset requested"
              query={resetRequested}
              hint="Somebody asked for a password reset link."
            />
            <Figure
              label="Reset completed"
              query={resetCompleted}
              hint="A reset link was used to set a new password."
            />
            <Figure
              label="Password changed"
              query={passwordChanged}
              hint="Changed from inside a signed-in session."
            />
            <Figure
              label="All sessions revoked"
              query={sessionsRevoked}
              hint="Every device signed out at once, by the account holder."
            />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="What this page cannot show"
          description="Named rather than left off, so an empty screen is never mistaken for a quiet one."
        />
        <CardBody>
          <dl className="flex flex-col gap-4">
            {UNANSWERABLE.map((item) => (
              <div key={item.title} className="flex flex-col gap-1">
                <dt className="flex items-center gap-2 text-sm font-medium text-fg">
                  <KeyRound className="size-4 text-fg-muted" aria-hidden="true" />
                  {item.title}
                </dt>
                <dd className="text-sm leading-relaxed text-fg-muted">{item.body}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** A link out to the full trail, pre-filtered to one verb and this window. */
function TrailLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <Link
      to={to}
      className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {label}
    </Link>
  );
}

/**
 * A labelled count.
 *
 * A skeleton while the figure is unknown and an em dash when the request
 * failed — never a zero, which on this page would read as "nobody reset a
 * password" when it meant "the request has not come back".
 */
function Figure({
  label,
  query,
  hint,
}: {
  label: string;
  query: SignalQuery;
  hint: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-fg">
        {query.isPending ? <Skeleton className="h-6 w-14" /> : figureOf(query)}
      </dd>
      <p className="text-xs leading-relaxed text-fg-muted">{hint}</p>
    </div>
  );
}
