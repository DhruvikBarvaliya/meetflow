import { useQuery } from '@tanstack/react-query';
import { ScrollText, X } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  CopyButton,
  DataState,
  FilterBar,
  FilterField,
  useDebouncedValue,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  DatePicker,
  Drawer,
  EmptyState,
  Input,
  Pagination,
  Select,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
  type BadgeTone,
  type SelectOption,
} from '@/components/ui';
import { browserTimezone, formatDateTime, formatRelative, humanizeEnum } from '@/lib/format';
import type {
  AdminAuditActorType,
  AdminAuditEntry,
  AdminAuditFilters,
  AdminWorkspaceFilters,
  AdminWorkspaceSummary,
} from '@/types/api';
import { adminAuditScope, fetchAdminAuditLogs, fetchAdminWorkspaces } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The forensic surface: every audited action on this deployment, in order.
 *
 * Each workspace already has its own activity feed, and for a question that
 * lives inside one workspace that feed is the better answer. This page exists
 * for the questions that do not. A tenant's feed can only ever show that
 * tenant, so "which account touched three different workspaces in ten minutes"
 * is not a query anybody can run there — not because it is forbidden, but
 * because the rows that would answer it are split across three feeds nobody can
 * hold open at once. Ordering across workspaces is the whole product of this
 * screen; the columns are secondary to the fact that they are sorted together.
 *
 * It stays inside the same privacy boundary as the rest of the admin surface.
 * An audit row records that an appointment was cancelled and by whom; it does
 * not record who the appointment was with. Nothing here reaches into a
 * workspace's contents, and the endpoint has no field that could.
 *
 * Filters live in the query string rather than in component state, and that is
 * load-bearing here rather than a nicety. Handing an investigation to a
 * colleague means sending them a link — the view they open has to be the view
 * you were looking at — and the workspace detail page links straight to
 * `/admin/audit?businessId=<id>`, so that parameter has to be honoured on first
 * paint and not merely settable from the control.
 */

// ---------------------------------------------------------------------------
// Vocabulary and small helpers
// ---------------------------------------------------------------------------

/**
 * Anything can be typed into a query string, and the endpoint's schema is
 * `.strict()` — an id that is not a uuid comes back as a 422 rather than as an
 * ignored filter. Values are checked here so a mangled or truncated link
 * degrades to the unfiltered trail instead of to an error page.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The workspace select's value for "rows belonging to no workspace at all".
 *
 * Deliberately not a uuid and never sent to the API: `businessId` is typed as a
 * uuid on the server, so there is no value that could express "is null" through
 * it. See `PLATFORM_ONLY_NOTE` for what the screen does instead.
 */
const PLATFORM_ONLY = 'platform';

/**
 * How many pages of workspaces the picker will walk.
 *
 * `fetchAdminWorkspaces` fixes the page size for every admin list, so "one
 * large page" is not a request this client can make; the picker pages through
 * instead. Ten pages is a deliberate ceiling rather than a guess at the largest
 * deployment: past it the dropdown stops being a usable control anyway, and the
 * URL still accepts any workspace id directly, which is how the link from a
 * workspace's own detail page arrives.
 */
const WORKSPACE_OPTION_PAGE_CAP = 10;

const WORKSPACE_PICKER_FILTERS: AdminWorkspaceFilters = {
  page: 1,
  search: '',
  status: '',
  sort: 'name',
};

/**
 * Actor pills.
 *
 * PUBLIC is amber, and it is the only one that carries a colour meaning "look
 * at this". An unauthenticated actor is not a fault — the public booking flow
 * writes these rows all day — but on a screen someone opens because something
 * went wrong, "nobody was signed in for this" is the fact worth finding without
 * reading the column. SYSTEM stays grey: the platform acting on its own
 * schedule is the least surprising row on the page.
 */
const ACTOR_TONES: Record<AdminAuditActorType, BadgeTone> = {
  USER: 'brand',
  CUSTOMER: 'info',
  SYSTEM: 'neutral',
  PUBLIC: 'warning',
  API: 'accent',
};

/**
 * Spelled out rather than passed through `humanizeEnum`, which would render
 * `API` as `Api` — an initialism it has no way to recognise.
 */
const ACTOR_LABELS: Record<AdminAuditActorType, string> = {
  USER: 'User',
  CUSTOMER: 'Customer',
  SYSTEM: 'System',
  PUBLIC: 'Public',
  API: 'API',
};

/**
 * `appointment.cancelled` becomes `Appointment cancelled`.
 *
 * Audit actions are dotted verbs rather than SCREAMING_SNAKE enums, so
 * `humanizeEnum` on its own would leave a full stop sitting in the middle of
 * the phrase. The raw verb is never thrown away — it is the `title` on the cell
 * and a copyable line in the drawer, because it is what a grep over the server
 * logs actually needs.
 */
function humaniseAction(action: string): string {
  return humanizeEnum(action.replace(/\./g, ' '));
}

/**
 * The first segment of a uuid, which is enough to tell two rows apart by eye.
 *
 * Thirty-six characters in a table cell pushes every other column off the
 * screen and is unreadable besides. The drawer carries the whole id, since that
 * is the one place somebody wants to copy it.
 */
function shortId(value: string): string {
  return `${value.slice(0, 8)}…`;
}

/**
 * A field the row does not carry renders an em dash.
 *
 * Never an empty cell: an empty cell cannot be told apart from a column this
 * page forgot to render, and on a forensic screen "the log did not record an IP
 * for this row" is itself a finding.
 */
function orDash(value: string | null): ReactNode {
  return value === null || value.trim() === '' ? <span className="text-fg-muted">—</span> : value;
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

/** The query-string keys this page owns. */
type FilterParam = 'businessId' | 'action' | 'entityType' | 'actorUserId' | 'from' | 'to' | 'page';

function readUuid(value: string | null): string {
  return value !== null && UUID_PATTERN.test(value) ? value : '';
}

function readIsoDate(value: string | null): string {
  return value !== null && ISO_DATE_PATTERN.test(value) ? value : '';
}

function readPage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The query string, read back as the filters the endpoint accepts.
 *
 * `businessId=platform` resolves to no workspace filter at all rather than to
 * an id, because the sentinel is a client-side view and the API must never see
 * it. The crossed-range case is dropped rather than forwarded: the schema
 * refuses a `to` earlier than its `from`, so a hand-edited link with the bounds
 * the wrong way round would 422 an operator who never chose to break it.
 */
function readFilters(params: URLSearchParams): AdminAuditFilters {
  const from = readIsoDate(params.get('from'));
  const to = readIsoDate(params.get('to'));

  return {
    page: readPage(params.get('page')),
    businessId: readUuid(params.get('businessId')),
    action: params.get('action') ?? '',
    entityType: params.get('entityType') ?? '',
    actorUserId: readUuid(params.get('actorUserId')),
    from,
    // ISO dates sort lexicographically, so the comparison needs no parsing.
    to: from !== '' && to !== '' && to < from ? '' : to,
  };
}

/**
 * Every workspace the picker can offer, walked page by page.
 *
 * Sorted by name rather than by recency: a dropdown is scanned alphabetically,
 * and "which of these is the one I want" is a different question from "what
 * changed lately", which the register answers better anyway.
 */
async function loadWorkspaceOptions(): Promise<AdminWorkspaceSummary[]> {
  const first = await fetchAdminWorkspaces(WORKSPACE_PICKER_FILTERS);
  const pages = Math.min(first.meta.totalPages, WORKSPACE_OPTION_PAGE_CAP);
  if (pages <= 1) return first.items;

  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) =>
      fetchAdminWorkspaces({ ...WORKSPACE_PICKER_FILTERS, page: index + 2 }),
    ),
  );
  return [first, ...rest].flatMap((page) => page.items);
}

const PLATFORM_ONLY_NOTE =
  'Platform events are picked out of the page in hand. The endpoint can filter to one workspace but has no filter for "belongs to no workspace", so the totals below still describe the whole trail, and a page with no platform-level rows on it reads as empty.';

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

/** An identifier rendered for copying by eye: monospaced and allowed to wrap. */
function IdValue({ value }: { value: string }): JSX.Element {
  return <span className="break-all font-mono text-xs text-fg-secondary">{value}</span>;
}

function AuditEntryDrawer({
  entry,
  zone,
  onClose,
}: {
  entry: AdminAuditEntry | null;
  zone: string;
  onClose: () => void;
}): JSX.Element {
  const metadataKeys = entry ? Object.keys(entry.metadata) : [];

  return (
    <Drawer
      open={entry !== null}
      onClose={onClose}
      title={entry ? humaniseAction(entry.action) : 'Audit entry'}
      description={
        entry
          ? `${formatDateTime(entry.createdAt, zone)} · ${formatRelative(entry.createdAt, zone)}`
          : undefined
      }
      width="lg"
    >
      {entry ? (
        <div className="flex flex-col gap-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            <DetailRow label="Action">
              <IdValue value={entry.action} />
            </DetailRow>
            <DetailRow label="Actor type">
              <Badge tone={ACTOR_TONES[entry.actorType]}>{ACTOR_LABELS[entry.actorType]}</Badge>
            </DetailRow>
            <DetailRow label="Actor">
              {/* Null where there is no account to name — the platform acting on
                  its own schedule, or an unauthenticated public request. */}
              {orDash(entry.actorLabel)}
            </DetailRow>
            <DetailRow label="Actor account">
              {entry.actorUserId === null ? (
                <span className="text-fg-muted">No account</span>
              ) : (
                <Link
                  to={`/admin/users/${entry.actorUserId}`}
                  className="break-all rounded-xs font-mono text-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {entry.actorUserId}
                </Link>
              )}
            </DetailRow>
            <DetailRow label="Entity type">{humanizeEnum(entry.entityType)}</DetailRow>
            <DetailRow label="Entity id">
              {entry.entityId === null ? (
                <span className="text-fg-muted">—</span>
              ) : (
                <IdValue value={entry.entityId} />
              )}
            </DetailRow>
            <DetailRow label="Workspace">
              {entry.businessId === null ? (
                <span className="text-fg-secondary">Platform</span>
              ) : (
                <Link
                  to={`/admin/workspaces/${entry.businessId}`}
                  className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {entry.businessName ?? shortId(entry.businessId)}
                </Link>
              )}
            </DetailRow>
            <DetailRow label="Workspace id">
              {entry.businessId === null ? (
                <span className="text-fg-muted">None</span>
              ) : (
                <IdValue value={entry.businessId} />
              )}
            </DetailRow>
            <DetailRow label="IP address">
              <span className="font-mono text-xs text-fg-secondary">{orDash(entry.ipAddress)}</span>
            </DetailRow>
            <DetailRow label="Audit row id">
              <IdValue value={entry.id} />
            </DetailRow>
          </dl>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Request id
            </h3>
            {/*
             * The reason most people open this drawer at all. Every server log
             * line for the request that wrote this row carries the same id, so
             * this is the join between "the trail says the booking was
             * cancelled" and "here is the stack that did it". It is worth a copy
             * button rather than a selection, because it is going straight into
             * a log search.
             *
             * The endpoint does not project the user agent, although the column
             * exists on `audit_logs`. Nothing is hidden here — the field simply
             * is not in the response, and widening the projection is a decision
             * for the admin contract rather than something this page can paper
             * over.
             */}
            {entry.requestId === null ? (
              <p className="text-sm text-fg-muted">
                No request id was recorded. That is normal for rows written by a background job,
                which has no inbound request to correlate with.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <code className="mf-scroll-x min-w-0 flex-1 truncate rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-fg-secondary">
                  {entry.requestId}
                </code>
                <CopyButton value={entry.requestId} label="request id" />
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Metadata
            </h3>
            {/*
             * Rendered exactly as stored. `recordAudit` runs every metadata
             * object through `sanitiseMetadata` on the way in, which replaces
             * token, password and authorisation keys with `[redacted]`, bounds
             * strings and caps depth — so what arrives here has already been
             * through the filter and there is nothing left for this page to
             * strip. Reformatting it would only risk hiding a key somebody came
             * to read.
             */}
            {metadataKeys.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Nothing recorded. The action carried no detail beyond the fields above.
              </p>
            ) : (
              <pre className="mf-scroll-x max-h-80 overflow-y-auto rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminAuditPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  /*
   * The signed-in operator's own clock, and only theirs.
   *
   * Every management screen renders in the workspace timezone, because a 9am
   * appointment means 9am where the clinic is. Here that would destroy the one
   * thing the page is for: a trail spanning fifty workspaces rendered against
   * fifty clocks cannot be read in order, and two rows a minute apart would
   * appear hours apart. `useAuth().user` carries no timezone field, so the
   * browser's zone is both the only source available and the right one — the
   * operator reads the whole page against a single clock they already know.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  /*
   * The sentinel is read from the raw parameter rather than from `filters`,
   * which has already resolved it away. Keeping the two apart is what stops
   * `platform` ever reaching `toSearchParams` and being sent to an endpoint
   * that would reject it.
   */
  const platformOnly = searchParams.get('businessId') === PLATFORM_ONLY;

  const [selected, setSelected] = useState<AdminAuditEntry | null>(null);

  /**
   * Merges a change into the query string.
   *
   * Typing replaces the current history entry and everything else pushes one,
   * so Back undoes choosing a filter rather than undoing a typed character.
   */
  const setFilters = useCallback(
    (patch: Partial<Record<FilterParam, string>>, replace = false): void => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') next.delete(key);
            else next.set(key, value);
          }
          // Any change but a page change returns the reader to page one. Page
          // nine of a narrower trail is usually past the end, and an empty
          // table reads as "nothing matches" rather than "you are too far in".
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  /*
   * The URL updates on every keystroke; the request does not.
   *
   * Debouncing the request rather than the URL keeps the boxes responsive and
   * the link shareable while spending one call per settled term. This endpoint
   * is rate limited per IP, and a call per character both wastes that budget
   * and produces results that flicker between prefixes.
   */
  const debouncedAction = useDebouncedValue(filters.action);
  const debouncedEntityType = useDebouncedValue(filters.entityType);

  const requestFilters = useMemo<AdminAuditFilters>(
    () => ({ ...filters, action: debouncedAction, entityType: debouncedEntityType }),
    [filters, debouncedAction, debouncedEntityType],
  );

  const auditQuery = useQuery({
    // The same object feeds the key and the query string, so the cache entry
    // and the request it caches cannot describe different filters.
    queryKey: adminKeys.auditLogs(adminAuditScope(requestFilters)),
    queryFn: () => fetchAdminAuditLogs(requestFilters),
    // Holds the current page on screen while the next one loads, so paging
    // through a long trail does not flash a skeleton between every click.
    placeholderData: (previous) => previous,
  });

  const workspacesQuery = useQuery({
    queryKey: adminKeys.workspaces({ picker: 'audit-filter', pages: WORKSPACE_OPTION_PAGE_CAP }),
    queryFn: loadWorkspaceOptions,
    // The register changes far more slowly than the trail it filters, and this
    // is several requests. Five minutes without refetching costs nothing worse
    // than a workspace created mid-session missing from the dropdown, where the
    // deep link still works.
    staleTime: 5 * 60_000,
  });

  const pageRows = auditQuery.data?.items ?? [];

  /*
   * The platform-only view is a narrowing of the page in hand, not a query.
   * `PLATFORM_ONLY_NOTE` is on screen whenever it is active precisely because
   * the totals underneath it then describe a larger set than the rows above —
   * a discrepancy an operator would otherwise read as a bug in the count.
   */
  const rows = platformOnly ? pageRows.filter((row) => row.businessId === null) : pageRows;

  const workspaceOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [
      { value: '', label: 'All workspaces' },
      { value: PLATFORM_ONLY, label: 'Platform events only' },
    ];
    const known = workspacesQuery.data ?? [];

    /*
     * A workspace filtered by a link the picker has not loaded — one past the
     * page cap, or one selected before the register arrived — still has to be
     * shown as chosen. Without this the select falls back to its first option
     * and silently misreports an active filter as "All workspaces". The name is
     * borrowed from the rows already on screen when they carry it, since that
     * is the only place this page has to look one up.
     */
    if (filters.businessId !== '' && !known.some((item) => item.id === filters.businessId)) {
      const named = pageRows.find((row) => row.businessId === filters.businessId);
      options.push({
        value: filters.businessId,
        label: named?.businessName ?? `Workspace ${shortId(filters.businessId)}`,
      });
    }

    for (const workspace of known) options.push({ value: workspace.id, label: workspace.name });
    return options;
  }, [workspacesQuery.data, filters.businessId, pageRows]);

  const hasFilters =
    platformOnly ||
    filters.businessId !== '' ||
    filters.action !== '' ||
    filters.entityType !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    (filters.actorUserId ?? '') !== '';

  const clearFilters = useCallback((): void => {
    setFilters({ businessId: '', action: '', entityType: '', actorUserId: '', from: '', to: '' });
  }, [setFilters]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every audited action across every workspace on this deployment, newest first. A workspace's own feed can only show that workspace, so this is the only place a question spanning several of them can be asked."
      >
        <FilterBar>
          <FilterField label="Workspace" className="min-w-[13rem]">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={platformOnly ? PLATFORM_ONLY : filters.businessId}
                onChange={(event) => setFilters({ businessId: event.target.value })}
                options={workspaceOptions}
              />
            )}
          </FilterField>

          {/*
           * Action and entity type are free text rather than selects on purpose.
           * The action vocabulary is large and open-ended — every module adds
           * its own dotted verbs, and `AuditActions` grows with the product — so
           * a fixed list of options would go stale the first time a new action
           * shipped, and would go stale silently: the missing verb would look
           * like an action nobody ever performs. A typed prefix stays correct
           * without anybody remembering to update this file.
           */}
          <FilterField label="Action">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={filters.action}
                placeholder="appointment.cancelled"
                onChange={(event) => setFilters({ action: event.target.value }, true)}
              />
            )}
          </FilterField>
          <FilterField label="Entity type">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={filters.entityType}
                placeholder="appointment"
                onChange={(event) => setFilters({ entityType: event.target.value }, true)}
              />
            )}
          </FilterField>

          <FilterField label="From">
            {({ id }) => (
              <DatePicker
                id={id}
                value={filters.from === '' ? null : filters.from}
                /*
                 * UTC, not the operator's zone, and this is the one place on the
                 * page where the two disagree. The endpoint cuts the range into
                 * whole UTC days, so a picker measuring "today" in Auckland would
                 * highlight a day the filter reads as tomorrow. The disclosure
                 * under this row says so rather than the screen pretending the
                 * clocks match.
                 */
                timezone="UTC"
                max={filters.to === '' ? undefined : filters.to}
                placeholder="Any date"
                onChange={(value) => setFilters({ from: value })}
              />
            )}
          </FilterField>
          <FilterField label="To">
            {({ id }) => (
              <DatePicker
                id={id}
                value={filters.to === '' ? null : filters.to}
                timezone="UTC"
                min={filters.from === '' ? undefined : filters.from}
                placeholder="Any date"
                onChange={(value) => setFilters({ to: value })}
              />
            )}
          </FilterField>

          {hasFilters ? (
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </FilterBar>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs leading-relaxed text-fg-muted">
            Times are shown in your own zone ({zone}). The date range is inclusive and cut into
            whole UTC days, which is how the trail is stored.
          </p>

          {/*
           * The actor filter has no control of its own — it arrives from a link
           * on an account's detail page. It still has to be visible: a trail
           * narrowed to one person that does not say so is the sort of thing an
           * operator draws a conclusion from and only later discovers was
           * filtered.
           */}
          {(filters.actorUserId ?? '') !== '' ? (
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken py-0.5 pl-2.5 pr-1 text-xs text-fg-secondary">
              <span className="font-mono">Actor {shortId(filters.actorUserId ?? '')}</span>
              <button
                type="button"
                onClick={() => setFilters({ actorUserId: '' })}
                aria-label="Stop filtering by this actor"
                className="flex size-5 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      </PageHeader>

      <Card>
        {platformOnly ? (
          <p className="border-b border-border bg-surface-sunken px-4 py-2.5 text-xs leading-relaxed text-fg-secondary">
            {PLATFORM_ONLY_NOTE}
          </p>
        ) : null}

        <DataState
          isPending={auditQuery.isPending}
          isError={auditQuery.isError}
          error={auditQuery.error}
          onRetry={() => void auditQuery.refetch()}
          isEmpty={rows.length === 0}
          columns={6}
          empty={
            <EmptyState
              icon={<ScrollText className="size-6" aria-hidden="true" />}
              /*
               * Three genuinely different findings, and running them together
               * wastes an operator's afternoon. An empty trail is a deployment
               * on which nothing has happened yet. No match is a filter to
               * loosen. A page with no platform rows on it is neither — the
               * rows exist, they are simply further down a trail that is being
               * narrowed one page at a time.
               */
              title={
                platformOnly && pageRows.length > 0
                  ? 'No platform-level events on this page'
                  : hasFilters
                    ? 'Nothing matches these filters'
                    : 'No activity recorded'
              }
              description={
                platformOnly && pageRows.length > 0
                  ? 'Every row on this page belongs to a workspace. Platform-level rows are rarer than workspace ones, so they may be several pages further back.'
                  : hasFilters
                    ? 'No audited action matches the workspace, verb and dates you have chosen. Widen the range or clear a filter.'
                    : 'Nothing audited has happened on this deployment yet. A row appears here the moment anybody signs in, books, or changes a setting.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer className="rounded-none border-0">
            <Table caption="Audited actions across every workspace on this deployment, newest first.">
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Actor</Th>
                  <Th>Workspace</Th>
                  <Th>IP</Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((entry) => (
                  <Tr key={entry.id} interactive onClick={() => setSelected(entry)}>
                    <Td>
                      {/*
                       * The row is clickable for a mouse, but the keyboard needs
                       * a real control to land on, and a `<tr>` with a tabindex
                       * is not one. The button carries the timestamp it shows,
                       * so its accessible name still begins with its visible
                       * text.
                       */}
                      <button
                        type="button"
                        onClick={() => setSelected(entry)}
                        aria-label={`${formatDateTime(entry.createdAt, zone)} — open the full audit entry`}
                        className="rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <time
                          dateTime={entry.createdAt}
                          className="block whitespace-nowrap font-medium tabular-nums text-fg"
                        >
                          {formatDateTime(entry.createdAt, zone)}
                        </time>
                        <span className="block text-xs text-fg-muted">
                          {formatRelative(entry.createdAt, zone)}
                        </span>
                      </button>
                    </Td>
                    <Td>
                      {/* The raw dotted verb is what a log search needs, so it
                          stays reachable on hover rather than being replaced. */}
                      <span className="font-medium text-fg" title={entry.action}>
                        {humaniseAction(entry.action)}
                      </span>
                    </Td>
                    <Td>
                      <span className="block text-fg-secondary">
                        {humanizeEnum(entry.entityType)}
                      </span>
                      {entry.entityId === null ? null : (
                        <span className="block font-mono text-xs text-fg-muted">
                          {shortId(entry.entityId)}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="block truncate text-fg-secondary">
                        {orDash(entry.actorLabel)}
                      </span>
                      <Badge tone={ACTOR_TONES[entry.actorType]} className="mt-1">
                        {ACTOR_LABELS[entry.actorType]}
                      </Badge>
                    </Td>
                    <Td>
                      {/*
                       * A null business is a genuinely platform-level event —
                       * an account suspended, a role changed — and not a row
                       * whose workspace went missing. Printing a dash here
                       * would send somebody looking for data that was never
                       * meant to exist.
                       */}
                      {entry.businessId === null ? (
                        <span className="text-fg-muted">Platform</span>
                      ) : (
                        <Link
                          to={`/admin/workspaces/${entry.businessId}`}
                          onClick={(event) => event.stopPropagation()}
                          className="rounded-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          {entry.businessName ?? shortId(entry.businessId)}
                        </Link>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-fg-secondary">
                        {orDash(entry.ipAddress)}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {auditQuery.data ? (
            <Pagination
              meta={auditQuery.data.meta}
              onPageChange={(next) => setFilters({ page: String(next) })}
              itemLabel="audit entries"
            />
          ) : null}
        </DataState>
      </Card>

      {/*
       * The whole row is held rather than an id: there is no endpoint for a
       * single audit entry, and the list row already carries every field the
       * drawer shows. A refetch cannot make this copy wrong either — the trail
       * is append-only, so a row that has been written never changes again.
       */}
      <AuditEntryDrawer entry={selected} zone={zone} onClose={() => setSelected(null)} />
    </>
  );
}
