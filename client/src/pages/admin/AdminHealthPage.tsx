import { useQuery } from '@tanstack/react-query';
import {
  Database,
  Inbox,
  RefreshCw,
  Server,
  ShieldAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Skeleton,
  buttonStyles,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { browserTimezone, formatNumber, formatRelative } from '@/lib/format';
import type { AdminHealth } from '@/types/api';
import { fetchAdminHealth } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The operations screen.
 *
 * Nobody opens this page when things are fine. It is read at the moment someone
 * suspects an outage, which sets the whole design: the answer has to be legible
 * in about two seconds, and every state on it has to come from the API rather
 * than from a verdict this page invented.
 *
 * Two things it deliberately does not do. It never says the platform is
 * "healthy" — `/admin/health` reports figures and no overall judgement, and a
 * green tick this page made up would be believed. And it treats a resolved
 * request as nothing more than "the API answered": the endpoint returns 200 even
 * when PostgreSQL is unreachable, because a 503 would take the one page that
 * could explain an outage down with the outage. Every state below is read from
 * `ok`, never from the status code.
 *
 * The one judgement this page does make is the outbox backlog rule, which is
 * named and explained at `BACKLOG_AGE_SECONDS` below.
 */

/**
 * How old the oldest already-due notification may get before this page calls the
 * backlog out, in seconds.
 *
 * Five minutes is well past a single delivery pass, so a message still sitting
 * there has not merely been unlucky with timing. Paired with a non-zero
 * `dueNow`, that is the signature of a delivery worker that is not running: the
 * rows keep arriving and nothing takes them away. It is deliberately the only
 * threshold on the page — every other figure is reported as given.
 */
const BACKLOG_AGE_SECONDS = 300;

/**
 * Seconds as a coarse, readable duration.
 *
 * `formatDuration` in `@/lib/format` is measured in minutes and stops at hours,
 * which is right for an appointment and wrong here: an API that has been up for
 * nine days would read "216 hr". Two units is the ceiling on purpose — nobody
 * reads "9 days 4 hr 17 min 3 sec" off an operations page.
 */
function formatSecondsCoarse(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} sec`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayLabel = `${days} day${days === 1 ? '' : 's'}`;
  return rest === 0 ? dayLabel : `${dayLabel} ${rest} hr`;
}

export default function AdminHealthPage(): JSX.Element {
  /*
   * The signed-in operator's own clock. There is no workspace in play on this
   * page at all — these are figures about the API process answering the request
   * — so the browser's zone is both the only available answer and the right one.
   */
  const zone = useMemo(() => browserTimezone(), []);

  /*
   * Polled every fifteen seconds, which is right here and wrong on the overview.
   *
   * This screen is watched while something is going wrong. The whole point of it
   * is to show a dependency coming back, or a backlog that keeps climbing, and a
   * figure that only moves when the operator remembers to reload can show
   * neither. What it costs is small: two connectivity probes, one aggregate over
   * `notifications`, and a read of `process.uptime()`.
   *
   * The overview is the opposite on both counts. It is a set of full-table
   * aggregates across every workspace, appointment and account on the platform,
   * and nothing it reports changes meaningfully inside a minute — polling it
   * would buy a number nobody is watching at the price of the heaviest query set
   * in the product, repeated forever in an idle tab.
   *
   * The timer pauses while the tab is in the background, which is the library
   * default and worth keeping: an abandoned tab should not be a standing load.
   */
  const health = useQuery({
    queryKey: adminKeys.health(),
    queryFn: fetchAdminHealth,
    refetchInterval: 15_000,
  });

  const data: AdminHealth | undefined = health.data;

  return (
    <>
      <PageHeader
        title="System health"
        description="Live checks against the API's dependencies, its delivery queue and the process itself. Refreshes on its own every fifteen seconds."
        actions={
          <div className="flex items-center gap-3">
            {data ? (
              /*
               * Plain text, not a live region. This line changes every fifteen
               * seconds; announced politely it would talk over an operator
               * trying to read the actual figures, and "updated a few seconds
               * ago" is not news worth interrupting anyone for.
               */
              <p className="text-xs text-fg-muted">
                Updated {formatRelative(data.generatedAt, zone)}
              </p>
            ) : null}
            {/*
             * The other half of an incident. This page answers "is a dependency
             * down and is the queue draining"; the security page answers "is
             * somebody attacking the front door". Neither can see the other's
             * signal, and an operator arriving here on a hunch should not have
             * to know the second screen exists to find it.
             */}
            <Link to="/admin/security" className={buttonStyles('secondary', 'sm')}>
              <ShieldAlert className="size-4" aria-hidden="true" />
              Security
            </Link>
            {/*
             * Deliberately not wired to `isFetching`: the poll would flip this
             * into a spinner every fifteen seconds, which reads as the page
             * struggling rather than as it working.
             */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void health.refetch()}
              leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {health.isError ? (
        <Card>
          <ErrorState error={health.error} onRetry={() => void health.refetch()} />
          <CardBody className="border-t border-border">
            <p className="text-sm leading-relaxed text-fg-muted">
              This endpoint answers 200 even when a dependency is down, so a failure to reach it is
              not a report of a broken database — it means the API itself did not answer. Check that
              the process is running and reachable before looking any further.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <DependencyCard
              name="PostgreSQL"
              icon={Database}
              check={data?.database}
              isLoading={health.isPending}
              failureTone="danger"
              failureLabel="Down"
              note={
                data && !data.database.ok
                  ? 'PostgreSQL is the system of record. While it is unreachable the API can neither read nor write, so this is an outage rather than a slowdown. The outbox figures below are reported as zero during it — they are counted from this same database and there is nothing to count them with.'
                  : 'The system of record. Every booking, account and audit row is read from and written to it, so nothing about MeetFlow degrades gracefully when it is gone.'
              }
            />
            <DependencyCard
              name="Redis"
              icon={Zap}
              check={data?.redis}
              isLoading={health.isPending}
              /*
               * Amber, not red, and the asymmetry with PostgreSQL above is real
               * rather than a shade of caution: Redis is not the system of
               * record. The card says so in both states, because an operator who
               * learns it during an incident learns it too late.
               */
              failureTone="warning"
              failureLabel="Degraded"
              note={
                data && !data.redis.ok
                  ? 'The API is still serving traffic. Caching degrades to a miss, so reads are slower but correct; rate limiting falls back to per-process counters, so protection narrows from cluster-wide to per-instance rather than disappearing. Booking correctness is not affected. This is worth fixing, not worth paging anyone out of bed for.'
                  : 'Caching, distributed rate limiting, advisory locks and the job backbone. Not the system of record: every one of those falls back to working without it, so a Redis outage makes MeetFlow slower rather than wrong.'
              }
            />
          </div>

          <OutboxCard
            outbox={data?.outbox}
            databaseOk={data?.database.ok ?? true}
            isLoading={health.isPending}
          />

          <ApiCard api={data?.api} isLoading={health.isPending} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface DependencyCardProps {
  name: string;
  icon: LucideIcon;
  /** Undefined until the first response lands. */
  check: AdminHealth['database'] | undefined;
  isLoading: boolean;
  /** How much a failure of *this* dependency actually matters. */
  failureTone: 'danger' | 'warning';
  failureLabel: string;
  /** What the current state means, in both directions. Always rendered. */
  note: string;
}

/**
 * One dependency, in one card.
 *
 * The reachable/failing state is carried by a worded badge as well as by colour,
 * so the page still reads on a colour-blind screen and in a printed incident
 * report. The error string is shown verbatim in monospace rather than being
 * prettified — it is the thing that gets pasted into a ticket.
 */
function DependencyCard({
  name,
  icon: Icon,
  check,
  isLoading,
  failureTone,
  failureLabel,
  note,
}: DependencyCardProps): JSX.Element {
  const failing = check !== undefined && !check.ok;

  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-md',
                failing
                  ? failureTone === 'danger'
                    ? 'bg-danger-subtle text-danger-text'
                    : 'bg-warning-subtle text-warning-text'
                  : 'bg-surface-sunken text-fg-muted',
              )}
              aria-hidden="true"
            >
              <Icon className="size-4" />
            </span>
            {name}
          </span>
        }
        actions={
          isLoading || check === undefined ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            <Badge tone={check.ok ? 'success' : failureTone} dot>
              {check.ok ? 'Reachable' : failureLabel}
            </Badge>
          )
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-fg-secondary">Round trip</span>
          {isLoading || check === undefined ? (
            <Skeleton className="h-6 w-16" />
          ) : (
            <span className="text-lg font-semibold tabular-nums text-fg">
              {formatNumber(check.latencyMs)} ms
            </span>
          )}
        </div>

        {check?.error ? (
          <p
            className={cn(
              'overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs',
              failureTone === 'danger'
                ? 'border-danger-border bg-danger-subtle text-danger-text'
                : 'border-warning-border bg-warning-subtle text-warning-text',
            )}
          >
            {check.error}
          </p>
        ) : null}

        <p
          className={cn(
            'text-sm leading-relaxed',
            failing
              ? failureTone === 'danger'
                ? 'rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-danger-text'
                : 'rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-warning-text'
              : 'text-fg-muted',
          )}
        >
          {note}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The notification outbox.
 *
 * Notifications are written in the same transaction as the change that caused
 * them and picked up afterwards by the delivery worker, which is what makes this
 * table the one place a stopped worker becomes visible: `dueNow` climbing while
 * `sent` stands still means every confirmation and reminder the platform has
 * promised is sitting here unsent, and nothing else in the product will say so.
 */
function OutboxCard({
  outbox,
  databaseOk,
  isLoading,
}: {
  outbox: AdminHealth['outbox'] | undefined;
  databaseOk: boolean;
  isLoading: boolean;
}): JSX.Element {
  const oldest = outbox?.oldestPendingAgeSeconds ?? null;

  // Both halves are required. A single message that has just come due is not a
  // backlog, and an old `oldestPendingAgeSeconds` with nothing due cannot happen
  // — the server only measures rows that are already due.
  const backlogged =
    outbox !== undefined && outbox.dueNow > 0 && oldest !== null && oldest > BACKLOG_AGE_SECONDS;

  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-md',
                backlogged
                  ? 'bg-warning-subtle text-warning-text'
                  : 'bg-surface-sunken text-fg-muted',
              )}
              aria-hidden="true"
            >
              <Inbox className="size-4" />
            </span>
            Notification outbox
          </span>
        }
        description="Every confirmation and reminder the platform has promised, and whether the delivery worker is taking them away."
      />
      <CardBody className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
          <HealthFigure label="Pending" value={outbox?.pending} isLoading={isLoading} />
          <HealthFigure label="Processing" value={outbox?.processing} isLoading={isLoading} />
          <HealthFigure label="Sent" value={outbox?.sent} isLoading={isLoading} />
          <HealthFigure label="Failed" value={outbox?.failed} isLoading={isLoading} />
          <HealthFigure label="Cancelled" value={outbox?.cancelled} isLoading={isLoading} />
        </dl>

        <dl className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <HealthFigure
            label="Due now"
            value={outbox?.dueNow}
            isLoading={isLoading}
            hint="Pending and already past the moment they were scheduled for."
          />
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
              Oldest due message
            </dt>
            <dd className="text-lg font-semibold tabular-nums text-fg">
              {isLoading || outbox === undefined ? (
                <Skeleton className="h-6 w-20" />
              ) : oldest === null ? (
                // Not "0 sec". Nothing being due at all and the oldest due
                // message being brand new are different facts, and the server
                // keeps them apart precisely so this line can too.
                <span className="text-base font-medium text-fg-secondary">Nothing due</span>
              ) : (
                formatSecondsCoarse(oldest)
              )}
            </dd>
            <p className="text-xs leading-relaxed text-fg-muted">
              Measured from when it was scheduled, over due messages only — a reminder set for next
              week is not late.
            </p>
          </div>
        </dl>

        {backlogged ? (
          <p className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm leading-relaxed text-warning-text">
            The queue is not draining. Messages are due and the oldest of them has been waiting
            longer than a delivery pass takes, which is what a stopped or stuck delivery worker
            looks like from here. Nothing in the outbox is lost — it will send once the worker runs
            — but until then no confirmation or reminder is going out.
          </p>
        ) : null}

        {!databaseOk ? (
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-fg-secondary">
            These counts come from PostgreSQL, which is not answering, so they are reported as zero
            rather than counted. Read them as unknown, not as an empty queue.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The process answering the request: which build, which environment, how long. */
function ApiCard({
  api,
  isLoading,
}: {
  api: AdminHealth['api'] | undefined;
  isLoading: boolean;
}): JSX.Element {
  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="flex items-center gap-2">
            <span
              className="flex size-7 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
              aria-hidden="true"
            >
              <Server className="size-4" />
            </span>
            API process
          </span>
        }
        description="Uptime is the process, not the host. A figure that keeps resetting is a crash loop, and that is worth seeing beside the dependency checks."
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <HealthText label="Environment" value={api?.environment} isLoading={isLoading} />
          <HealthText label="Node" value={api?.node} isLoading={isLoading} />
          <HealthText
            label="Uptime"
            value={api ? formatSecondsCoarse(api.uptimeSeconds) : undefined}
            isLoading={isLoading}
          />
          <HealthText label="API version" value={api?.apiVersion} isLoading={isLoading} />
        </dl>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/**
 * A labelled count.
 *
 * Renders a skeleton rather than a zero while the figure is unknown. On this
 * page in particular, a zero read as "nothing pending" when it actually meant
 * "not loaded yet" would end an investigation at exactly the wrong moment.
 */
function HealthFigure({
  label,
  value,
  isLoading,
  hint,
}: {
  label: string;
  value: number | undefined;
  isLoading: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-fg">
        {isLoading || value === undefined ? <Skeleton className="h-6 w-14" /> : formatNumber(value)}
      </dd>
      {hint ? <p className="text-xs leading-relaxed text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/** A labelled string — a version, an environment name. */
function HealthText({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: string | undefined;
  isLoading: boolean;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="truncate font-mono text-sm text-fg">
        {isLoading || value === undefined ? <Skeleton className="h-5 w-20" /> : value}
      </dd>
    </div>
  );
}
