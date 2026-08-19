import { useQuery } from '@tanstack/react-query';
import { Download, ScrollText, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/layout';
import {
  CopyButton,
  DataState,
  FilterBar,
  FilterField,
  SearchField,
  useCsvExport,
  useDebouncedValue,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  DatePicker,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
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
  type SelectOption,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime, formatRelative, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import type { AuditActorType, AuditLogFilters, MemberFilters, MemberRecord } from '@/types/api';
import {
  auditExportUrl,
  auditScope,
  fetchAuditEntries,
  fetchAuditEntry,
  fetchMembers,
  workspaceKeys,
} from './workspaceApi';

/**
 * This workspace's own audit trail.
 *
 * Eighteen services write to `audit_logs` on every mutation; until
 * `/api/v1/audit-logs` shipped no tenant could read a single one of them, so
 * "the business sees what happened in its own workspace" was a property the
 * database held and the product did not expose.
 *
 * A near-twin of `pages/admin/AdminAuditPage.tsx` in shape, and deliberately
 * unlike it in three ways that all follow from being tenant-scoped:
 *
 *  - **There is no workspace filter and no workspace column.** The tenant comes
 *    from the caller's membership and no parameter this endpoint accepts can
 *    widen it, so every row on screen belongs here by construction. Platform
 *    level rows — an account suspended, a platform role changed — belong to no
 *    workspace and can never appear.
 *  - **Times and the date range are the workspace's, not the reader's.** The
 *    admin screen renders in the operator's own zone because a trail spanning
 *    fifty workspaces cannot be read against fifty clocks. Here there is one
 *    clock and it is the one the business runs on: the server cuts `from` and
 *    `to` into whole days `AT TIME ZONE` the workspace's timezone, and echoes
 *    that zone back in the response `meta` so a client cannot label the pickers
 *    dishonestly.
 *  - **A row can be opened in full.** `GET /audit-logs/{id}` exists on this
 *    surface and carries the user agent, which the list projection omits.
 *
 * Filters live in component state rather than the query string, which is the
 * one place this page is weaker than the admin one. Nothing links into it yet,
 * so there is no view to arrive pre-filtered from; the moment something does —
 * an appointment page offering "everything that happened to this booking" — the
 * `entityId` filter below is what it would set, and the filters should move to
 * the URL so that link survives being sent to somebody else.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Actor pills.
 *
 * PUBLIC is amber and is the only one carrying a colour that means "look at
 * this". An unauthenticated actor is not a fault — the public booking page
 * writes these rows all day — but on a screen somebody opens because something
 * went wrong, "nobody was signed in for this" is the fact worth finding without
 * reading the column. SYSTEM stays grey: a scheduled job doing its job is the
 * least surprising row on the page.
 */
const ACTOR_TONES: Record<AuditActorType, BadgeTone> = {
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
const ACTOR_LABELS: Record<AuditActorType, string> = {
  USER: 'User',
  CUSTOMER: 'Customer',
  SYSTEM: 'System',
  PUBLIC: 'Public',
  API: 'API',
};

const EMPTY_FILTERS: AuditLogFilters = {
  page: 1,
  action: '',
  entityType: '',
  entityId: '',
  actorUserId: '',
  search: '',
  from: '',
  to: '',
};

/**
 * How many pages of members the actor picker will walk.
 *
 * `fetchMembers` fixes the page size, so "one large page" is not a request this
 * client can make. Five pages is a deliberate ceiling rather than a guess at the
 * largest workspace: past a hundred names a dropdown has stopped being a usable
 * control, and the free-text search below still finds an actor by their address.
 */
const ACTOR_PAGE_CAP = 5;

const ACTOR_PICKER_FILTERS: MemberFilters = {
  page: 1,
  search: '',
  status: '',
  roleId: '',
  // Somebody who has left the workspace is still named by everything they did
  // while they were in it. Leaving them out of the picker would make exactly the
  // trail most worth reading — a departed colleague's — the one that cannot be
  // filtered to.
  includeRemoved: true,
};

/**
 * `appointment.cancelled` becomes `Appointment cancelled`.
 *
 * Audit actions are dotted verbs rather than SCREAMING_SNAKE enums, so
 * `humanizeEnum` alone would leave a full stop in the middle of the phrase. The
 * raw verb is never thrown away — it is the exact string the filter matches on
 * and what a grep over the server logs needs.
 */
function humaniseAction(action: string): string {
  return humanizeEnum(action.replace(/\./g, ' '));
}

/** The first segment of a uuid — enough to tell two rows apart by eye. */
function shortId(value: string): string {
  return `${value.slice(0, 8)}…`;
}

/**
 * A field the row does not carry renders an em dash, never an empty cell.
 *
 * An empty cell cannot be told apart from a column this page forgot to render,
 * and on a forensic screen "the trail recorded no IP for this row" is itself a
 * finding.
 */
function orDash(value: string | null): ReactNode {
  return value === null || value.trim() === '' ? <span className="text-fg-muted">—</span> : value;
}

/** Every member the picker can offer, walked page by page. */
async function loadActorOptions(): Promise<MemberRecord[]> {
  const first = await fetchMembers(ACTOR_PICKER_FILTERS);
  const pages = Math.min(first.meta.totalPages, ACTOR_PAGE_CAP);
  if (pages <= 1) return first.items;

  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) =>
      fetchMembers({ ...ACTOR_PICKER_FILTERS, page: index + 2 }),
    ),
  );
  return [first, ...rest].flatMap((page) => page.items);
}

// ---------------------------------------------------------------------------
// Detail
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

/**
 * One entry in full.
 *
 * Fetched by id rather than reused from the list row, and worth the request: the
 * detail projection is the only shape that carries the user agent, and the trail
 * is append-only, so a row that has been written can never contradict the copy
 * that was clicked.
 */
function AuditEntryDrawer({
  entryId,
  open,
  onClose,
  onFilterEntity,
}: {
  entryId: string | null;
  open: boolean;
  onClose: () => void;
  onFilterEntity: (entityId: string) => void;
}): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();

  const entryQuery = useQuery({
    queryKey: workspaceKeys.auditEntry(activeBusinessId, entryId ?? ''),
    queryFn: () => fetchAuditEntry(entryId ?? ''),
    enabled: open && entryId !== null,
    // An audit row is immutable once written, so a cached copy can never go
    // stale. Refetching one would only cost a request to receive the same bytes.
    staleTime: Infinity,
  });

  const entry = entryQuery.data;
  const metadataKeys = entry ? Object.keys(entry.metadata) : [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={entry ? humaniseAction(entry.action) : 'Audit entry'}
      description={
        entry
          ? `${formatDateTime(entry.createdAt, activeTimezone)} · ${formatRelative(
              entry.createdAt,
              activeTimezone,
            )}`
          : undefined
      }
      width="lg"
    >
      {entryQuery.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : entryQuery.isError ? (
        <ErrorState error={entryQuery.error} onRetry={() => void entryQuery.refetch()} />
      ) : entry ? (
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
                  its own schedule, or an unauthenticated public booking. */}
              {orDash(entry.actorLabel)}
            </DetailRow>
            <DetailRow label="Actor account">
              {entry.actorUserId === null ? (
                <span className="text-fg-muted">No account</span>
              ) : (
                <IdValue value={entry.actorUserId} />
              )}
            </DetailRow>
            <DetailRow label="Entity type">{humanizeEnum(entry.entityType)}</DetailRow>
            <DetailRow label="Entity id">
              {entry.entityId === null ? (
                <span className="text-fg-muted">—</span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <IdValue value={entry.entityId} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onFilterEntity(entry.entityId ?? '')}
                  >
                    Show this record&apos;s history
                  </Button>
                </span>
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
             * line written while handling the request that produced this row
             * carries the same id, so this is the join between "the trail says
             * the booking was cancelled" and "here is what the process was
             * doing". A copy button rather than a selection, because it is going
             * straight into a log search.
             */}
            {entry.requestId === null ? (
              <p className="text-sm leading-relaxed text-fg-muted">
                No request id was recorded. That is normal for a row written by a background job,
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
              User agent
            </h3>
            <p className="break-all text-sm leading-relaxed text-fg-secondary">
              {entry.userAgent === null || entry.userAgent === '' ? (
                <span className="text-fg-muted">Not recorded.</span>
              ) : (
                entry.userAgent
              )}
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Metadata
            </h3>
            {/*
             * Rendered exactly as stored. `recordAudit` runs every metadata
             * object through `sanitiseMetadata` on the way in — token, password
             * and authorisation keys become `[redacted]`, strings are bounded and
             * depth is capped — so what arrives has already been through the
             * filter and there is nothing left for this page to strip.
             * Reformatting it would only risk hiding a key somebody came to read.
             */}
            {metadataKeys.length === 0 ? (
              <p className="text-sm leading-relaxed text-fg-muted">
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

export default function AuditLogPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const csv = useCsvExport();

  const [filters, setFilters] = useState<AuditLogFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);

  const canReadMembers = can(PERMISSIONS.MEMBERS_READ);
  const canExport = can(PERMISSIONS.REPORTS_EXPORT);

  /*
   * The controls update on every keystroke; the request does not. Debouncing
   * the request rather than the control keeps the boxes responsive while
   * spending one call per settled term — this API is rate limited per IP, and a
   * call per character both wastes that budget and produces results that flicker
   * between prefixes.
   */
  const debouncedSearch = useDebouncedValue(filters.search);
  const debouncedAction = useDebouncedValue(filters.action);
  const debouncedEntityType = useDebouncedValue(filters.entityType);

  const requestFilters = useMemo<AuditLogFilters>(
    () => ({
      ...filters,
      search: debouncedSearch,
      action: debouncedAction,
      entityType: debouncedEntityType,
    }),
    [filters, debouncedSearch, debouncedAction, debouncedEntityType],
  );

  const auditQuery = useQuery({
    // The same object feeds the key and the query string, so a cache entry and
    // the request it caches cannot describe different filters.
    queryKey: workspaceKeys.auditEntries(activeBusinessId, auditScope(requestFilters)),
    queryFn: () => fetchAuditEntries(requestFilters),
    // Holds the current page on screen while the next one loads, so paging
    // through a long trail does not flash a skeleton between every click.
    placeholderData: (previous) => previous,
  });

  const actorsQuery = useQuery({
    // Deliberately under the members prefix rather than beside the audit keys:
    // this *is* the membership list, fetched for a different purpose, and a
    // membership write should refresh it. `memberInvalidationKeys` invalidates
    // that prefix, so inviting somebody puts them in this dropdown without
    // MembersPage having to know the picker exists.
    queryKey: workspaceKeys.members(activeBusinessId, { picker: 'audit-actor' }),
    queryFn: loadActorOptions,
    enabled: canReadMembers,
    // The membership list changes far more slowly than the trail it filters, and
    // this is several requests. Five minutes without refetching costs nothing
    // worse than a colleague invited mid-session missing from the dropdown.
    staleTime: 5 * 60_000,
  });

  const rows = auditQuery.data?.items ?? [];

  const actorOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value: '', label: 'Anyone' }];
    for (const member of actorsQuery.data ?? []) {
      options.push({
        value: member.user.id,
        label:
          member.status === 'REMOVED' ? `${member.user.fullName} (left)` : member.user.fullName,
      });
    }
    return options;
  }, [actorsQuery.data]);

  const hasFilters =
    filters.search !== '' ||
    filters.action !== '' ||
    filters.entityType !== '' ||
    filters.entityId !== '' ||
    filters.actorUserId !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  const patch = (next: Partial<AuditLogFilters>): void => {
    // Any change but a page change returns the reader to page one. Page nine of
    // a narrower trail is usually past the end, and an empty table then reads as
    // "nothing matches" rather than "you are too far in".
    setFilters((current) => ({ ...current, ...next, ...('page' in next ? {} : { page: 1 }) }));
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every audited action in this workspace, newest first — who did it, to what, and from where. Rows are written by the server and can never be edited or deleted."
        actions={
          canExport ? (
            <Button
              variant="secondary"
              loading={csv.isExporting}
              onClick={() => void csv.download(auditExportUrl(requestFilters), 'audit-log.csv')}
              leadingIcon={<Download className="size-4" aria-hidden="true" />}
            >
              Export CSV
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={filters.search}
            placeholder="Actor, action or entity"
            onChange={(value) => patch({ search: value })}
          />

          <FilterField label="Actor" className="min-w-[12rem]">
            {({ id }) =>
              canReadMembers ? (
                <Select
                  id={id}
                  selectSize="sm"
                  value={filters.actorUserId}
                  onChange={(event) => patch({ actorUserId: event.target.value })}
                  options={actorOptions}
                />
              ) : (
                /*
                 * The picker is a list of colleagues, so offering it needs
                 * `members:read`. Without it the actor is still findable — the
                 * search box above matches the actor snapshot the trail stores —
                 * which is why this degrades to a note rather than to a disabled
                 * control nobody can act on.
                 */
                <p className="py-1.5 text-xs leading-relaxed text-fg-muted">
                  Needs members:read. Search by name or address instead.
                </p>
              )
            }
          </FilterField>

          {/*
           * Action and entity type are free text, and both match *exactly* —
           * `l.action = $action`, not a prefix or a LIKE. A fixed dropdown was
           * the alternative and would go stale silently: every module adds its
           * own dotted verbs, and a verb missing from the list would look like an
           * action nobody ever performs. Exact matching is the cost of that
           * choice, so the hint says so and the table makes every verb on screen
           * clickable — which is how anybody discovers the spelling without
           * having to know it.
           */}
          <FilterField label="Action (exact)">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={filters.action}
                placeholder="appointment.cancelled"
                onChange={(event) => patch({ action: event.target.value })}
              />
            )}
          </FilterField>
          <FilterField label="Entity type (exact)">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={filters.entityType}
                placeholder="appointment"
                onChange={(event) => patch({ entityType: event.target.value })}
              />
            )}
          </FilterField>

          <FilterField label="From">
            {({ id }) => (
              <DatePicker
                id={id}
                value={filters.from === '' ? null : filters.from}
                timezone={activeTimezone}
                max={filters.to === '' ? undefined : filters.to}
                placeholder="Any date"
                onChange={(value) => patch({ from: value })}
              />
            )}
          </FilterField>
          <FilterField label="To">
            {({ id }) => (
              <DatePicker
                id={id}
                value={filters.to === '' ? null : filters.to}
                timezone={activeTimezone}
                min={filters.from === '' ? undefined : filters.from}
                placeholder="Any date"
                onChange={(value) => patch({ to: value })}
              />
            )}
          </FilterField>

          {hasFilters ? (
            <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          ) : null}
        </FilterBar>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs leading-relaxed text-fg-muted">
            Times are shown in this workspace&apos;s zone ({activeTimezone}). The date range is
            inclusive and cut into whole days on the same clock, so a Tuesday here is the
            workspace&apos;s Tuesday wherever you are reading from.
          </p>

          {/*
           * The record filter has no control of its own — it is set from a row's
           * drawer. It still has to be visible: a trail narrowed to one booking
           * that does not say so is exactly the sort of thing somebody draws a
           * conclusion from and only later discovers was filtered.
           */}
          {filters.entityId !== '' ? (
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken py-0.5 pl-2.5 pr-1 text-xs text-fg-secondary">
              <span className="font-mono">One record: {shortId(filters.entityId)}</span>
              <button
                type="button"
                onClick={() => patch({ entityId: '' })}
                aria-label="Stop filtering to this record"
                className="flex size-5 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      </PageHeader>

      <Card>
        <DataState
          isPending={auditQuery.isPending}
          isError={auditQuery.isError}
          error={auditQuery.error}
          onRetry={() => void auditQuery.refetch()}
          isEmpty={rows.length === 0}
          columns={5}
          empty={
            <EmptyState
              icon={<ScrollText className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'Nothing matches these filters' : 'No activity recorded yet'}
              description={
                hasFilters
                  ? 'Action and entity type match exactly, so a near-miss returns nothing. Try the search box, widen the dates, or clear a filter.'
                  : 'A row appears here the moment anybody in this workspace signs in, books, or changes a setting.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Audited actions in this workspace, newest first.">
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Actor</Th>
                  <Th>IP</Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((entry) => (
                  <Tr key={entry.id} interactive onClick={() => setSelected(entry.id)}>
                    <Td>
                      {/*
                       * The row is clickable for a mouse, but a keyboard needs a
                       * real control to land on and a `<tr>` with a tabindex is
                       * not one. The button carries the timestamp it shows, so
                       * its accessible name begins with its visible text.
                       */}
                      <button
                        type="button"
                        onClick={() => setSelected(entry.id)}
                        aria-label={`${formatDateTime(entry.createdAt, activeTimezone)} — open the full audit entry`}
                        className="rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <time
                          dateTime={entry.createdAt}
                          className="block whitespace-nowrap font-medium tabular-nums text-fg"
                        >
                          {formatDateTime(entry.createdAt, activeTimezone)}
                        </time>
                        <span className="block text-xs text-fg-muted">
                          {formatRelative(entry.createdAt, activeTimezone)}
                        </span>
                      </button>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          patch({ action: entry.action });
                        }}
                        title={`Filter to ${entry.action}`}
                        className="rounded-xs text-left font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {humaniseAction(entry.action)}
                      </button>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          patch({ entityType: entry.entityType });
                        }}
                        title={`Filter to ${entry.entityType}`}
                        className="block rounded-xs text-left text-fg-secondary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {humanizeEnum(entry.entityType)}
                      </button>
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
              onPageChange={(page) => patch({ page })}
              itemLabel="audit entries"
            />
          ) : null}
        </DataState>
      </Card>

      <AuditEntryDrawer
        entryId={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
        onFilterEntity={(entityId) => {
          patch({ entityId });
          setSelected(null);
        }}
      />
    </>
  );
}
