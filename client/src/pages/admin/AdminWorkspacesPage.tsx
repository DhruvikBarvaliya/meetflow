import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  DataState,
  FilterBar,
  FilterField,
  SearchField,
  useDebouncedValue,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
} from '@/components/ui';
import { browserTimezone, formatDate, formatNumber, humanizeEnum } from '@/lib/format';
import type { AdminWorkspaceFilters, AdminWorkspaceSort, AdminWorkspaceStatus } from '@/types/api';
import { adminWorkspaceScope, fetchAdminWorkspaces } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The tenant register: every workspace on this deployment, in one table.
 *
 * This is the only screen in MeetFlow that looks *across* tenants, and its
 * columns are the whole argument for it existing. Each row says how big a
 * workspace is and who is answerable for it — a count of members, a count of
 * bookings, an owner to write to — and says nothing whatever about what is
 * inside it. The admin API has no field for a customer's name or an
 * appointment's contents, so there is nothing here that could leak one by
 * accident. An operator can see that a clinic took eleven thousand bookings;
 * they cannot see a single patient.
 *
 * Filters live in the query string rather than in component state, because the
 * most common thing an operator does with a filtered view is send it to
 * somebody. "The four suspended workspaces, newest first" has to survive being
 * pasted into a chat window, and a `useState` filter cannot. It also makes Back
 * undo a filter change, which is what that control is for.
 */

/**
 * Workspace status pills.
 *
 * Declared here rather than in `components/owner/StatusBadge.tsx` because that
 * module belongs to the tenant surface, and a workspace never sees its own
 * lifecycle status — only an operator does. Suspended is amber rather than red:
 * it is a reversible administrative decision, not a fault, and reserving red
 * for faults is what keeps red meaning something.
 */
const WORKSPACE_STATUS_TONES: Record<AdminWorkspaceStatus, BadgeTone> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  ARCHIVED: 'neutral',
};

/**
 * Exported so the workspace detail page wears the identical pill. Two copies of
 * this mapping would eventually disagree, and a status that is amber on one
 * screen and grey on the next is worse than no colour at all.
 */
export function WorkspaceStatusBadge({ status }: { status: AdminWorkspaceStatus }): JSX.Element {
  return (
    <Badge tone={WORKSPACE_STATUS_TONES[status]} dot>
      {humanizeEnum(status)}
    </Badge>
  );
}

const STATUS_VALUES: readonly AdminWorkspaceStatus[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'];
const SORT_VALUES: readonly AdminWorkspaceSort[] = ['newest', 'oldest', 'name', 'appointments'];
const DEFAULT_SORT: AdminWorkspaceSort = 'newest';

const STATUS_OPTIONS = [
  { value: '', label: 'Every status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ARCHIVED', label: 'Archived' },
];

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
  { value: 'appointments', label: 'Most appointments' },
];

/**
 * The query string, read back as filters.
 *
 * Anything unrecognised falls back to the default rather than being forwarded
 * to the API: a hand-edited `?status=deleted` should show the unfiltered
 * register, not a 422 from a screen the operator never chose to break.
 */
function readFilters(params: URLSearchParams): AdminWorkspaceFilters {
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  const rawStatus = params.get('status');
  const rawSort = params.get('sort');

  return {
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    search: params.get('search') ?? '',
    status: STATUS_VALUES.find((value) => value === rawStatus) ?? '',
    sort: SORT_VALUES.find((value) => value === rawSort) ?? DEFAULT_SORT,
  };
}

/**
 * Filters, written back as a query string.
 *
 * Defaults are left out so the address bar stays readable and a link to the
 * plain register is `/admin/workspaces` rather than four redundant parameters.
 */
function writeFilters(filters: AdminWorkspaceFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search !== '') params.set('search', filters.search);
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params;
}

export default function AdminWorkspacesPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  /*
   * The operator's own clock, not each workspace's.
   *
   * Every other surface in MeetFlow renders in the workspace timezone, because
   * a 9am appointment means 9am where the clinic is. On this table that would
   * be actively misleading: fifty rows read against fifty clocks cannot be
   * compared, and "created before this one" would stop agreeing with the
   * ordering. One consistent clock is the whole point of the column, and
   * `useAuth().user` carries no timezone field, so the browser's zone is the
   * only honest source for it.
   */
  const zone = useMemo(() => browserTimezone(), []);

  /*
   * The debounce sits between the URL and the request, not between the box and
   * the URL. Writing every keystroke to the query string keeps the URL the
   * single source of truth — Back, a reload and a pasted link all repaint the
   * search box correctly — while the API still sees one request per pause.
   * Debouncing the other way round leaves a pending timer racing the URL, and
   * pressing Back mid-type would put the half-typed term straight back.
   */
  const debouncedSearch = useDebouncedValue(filters.search);
  const requestFilters = useMemo<AdminWorkspaceFilters>(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );

  const update = useCallback(
    (patch: Partial<AdminWorkspaceFilters>): void => {
      // Any filter change returns to page one. Page seven of "everything" is
      // rarely page seven of "suspended only", and an out-of-range page reads
      // as "there is nothing here" rather than "you have paged past the end".
      const next = { ...filters, page: 1, ...patch };
      // A keystroke replaces the current history entry; anything else pushes
      // one. Back should undo choosing a filter, not undo a typed character.
      setSearchParams(writeFilters(next), { replace: patch.search !== undefined });
    },
    [filters, setSearchParams],
  );

  const listQuery = useQuery({
    queryKey: adminKeys.workspaces(adminWorkspaceScope(requestFilters)),
    queryFn: () => fetchAdminWorkspaces(requestFilters),
    // Keeps the current page on screen while the next one loads, so paging
    // through the register does not flash a skeleton between every click.
    placeholderData: (previous) => previous,
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters =
    filters.search !== '' || filters.status !== '' || filters.sort !== DEFAULT_SORT;

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Every workspace on this deployment, with how much it holds and who is answerable for it. Counts only — this surface exposes no customer, booking or note."
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={filters.search}
            placeholder="Name or slug"
            onChange={(value) => update({ search: value })}
          />
          <FilterField label="Status">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.status}
                onChange={(event) =>
                  update({
                    // The options are exactly `STATUS_VALUES` plus the empty
                    // string, so this narrowing can only fall through if
                    // somebody edits the list without editing the type.
                    status: STATUS_VALUES.find((value) => value === event.target.value) ?? '',
                  })
                }
                options={STATUS_OPTIONS}
              />
            )}
          </FilterField>
          <FilterField label="Sort by">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.sort}
                onChange={(event) =>
                  update({
                    sort: SORT_VALUES.find((value) => value === event.target.value) ?? DEFAULT_SORT,
                  })
                }
                options={SORT_OPTIONS}
              />
            )}
          </FilterField>
        </FilterBar>
      </PageHeader>

      <Card>
        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          columns={6}
          empty={
            <EmptyState
              icon={<Building2 className="size-6" aria-hidden="true" />}
              /*
               * Two genuinely different findings, and conflating them wastes an
               * operator's afternoon: an empty platform is a deployment nobody
               * has used yet, while an empty filter result means the workspace
               * they are hunting for is sitting one control away.
               */
              title={hasFilters ? 'No workspace matches these filters' : 'No workspaces yet'}
              description={
                hasFilters
                  ? 'Nothing on this deployment matches the search and status you have chosen.'
                  : 'Nothing has been created on this deployment. A workspace appears here as soon as somebody signs up and names one.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="secondary"
                    onClick={() => update({ search: '', status: '', sort: DEFAULT_SORT })}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer className="rounded-none border-0">
            <Table caption="Workspaces on this deployment, with their owner and their totals.">
              <THead>
                <Tr>
                  <Th>Workspace</Th>
                  <Th>Status</Th>
                  <Th>Owner</Th>
                  <Th align="right">Members</Th>
                  <Th align="right">Appointments</Th>
                  <Th>Created</Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((workspace) => (
                  <Tr key={workspace.id}>
                    <Td>
                      <Link
                        to={`/admin/workspaces/${workspace.id}`}
                        className="rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {workspace.name}
                      </Link>
                      <span className="block truncate text-xs text-fg-muted">
                        /{workspace.slug}
                      </span>
                    </Td>
                    <Td>
                      <WorkspaceStatusBadge status={workspace.status} />
                    </Td>
                    <Td>
                      {/* Null when the owning account has been soft-deleted out
                          from under the workspace. That is a real state worth
                          naming rather than printing a bare dash for. */}
                      {workspace.owner ? (
                        <span className="block truncate">{workspace.owner.email}</span>
                      ) : (
                        <span className="text-fg-muted">No owner account</span>
                      )}
                    </Td>
                    <Td numeric>{formatNumber(workspace.counts.members)}</Td>
                    <Td numeric>{formatNumber(workspace.counts.appointments)}</Td>
                    <Td>
                      <time dateTime={workspace.createdAt} className="tabular-nums">
                        {formatDate(workspace.createdAt, zone)}
                      </time>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination
              meta={listQuery.data.meta}
              onPageChange={(page) => update({ page })}
              itemLabel="workspaces"
            />
          ) : null}
        </DataState>
      </Card>
    </>
  );
}
