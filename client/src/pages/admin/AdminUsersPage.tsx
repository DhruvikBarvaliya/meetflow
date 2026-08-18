import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, UsersRound } from 'lucide-react';
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
  Avatar,
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
import { browserTimezone, formatDate, formatNumber, formatRelative } from '@/lib/format';
import type { AdminUserFilters, AdminUserSort, PlatformRole, UserStatus } from '@/types/api';
import { adminUserScope, fetchAdminUsers } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The account register: every person who holds credentials on this deployment.
 *
 * Two things about it are worth stating rather than inferring.
 *
 * This is a list of **platform accounts**, not of people. A customer who books
 * with a clinic has no account and never appears here — the admin API exposes
 * no customer record at all, which is the privacy boundary the whole surface is
 * shaped around. An operator running the platform has no business reading a
 * clinic's patient list, and the absence of the field is what enforces that.
 *
 * The filters live in the URL rather than in component state. A support
 * conversation about an account almost always begins with somebody pasting a
 * link, and a link that reopens "suspended administrators, sorted by last
 * seen" is worth far more than one that reopens an unfiltered register. It also
 * means the browser's back button undoes a filter change, which is what people
 * try first.
 */

/*
 * The filter vocabularies, declared once and used three ways: to render the
 * selects, to validate what arrives in the URL, and to type the filter state.
 *
 * Validation is the load-bearing one. Anything can be typed into a query
 * string, and the server's query schema is `.strict()` — an unrecognised
 * `?status=` is a 422 rather than an ignored filter. Narrowing here means a
 * mangled link degrades to the unfiltered register instead of to an error page.
 */

const STATUS_OPTIONS: Array<{ value: UserStatus | ''; label: string }> = [
  { value: '', label: 'Every status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INVITED', label: 'Invited' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'DEACTIVATED', label: 'Deactivated' },
];

const ROLE_OPTIONS: Array<{ value: PlatformRole | ''; label: string }> = [
  { value: '', label: 'Everyone' },
  { value: 'ADMIN', label: 'Administrator' },
  { value: 'USER', label: 'Member' },
];

const SORT_OPTIONS: Array<{ value: AdminUserSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
  { value: 'lastLogin', label: 'Last seen' },
];

const STATUS_VALUES: readonly UserStatus[] = ['ACTIVE', 'INVITED', 'SUSPENDED', 'DEACTIVATED'];
const ROLE_VALUES: readonly PlatformRole[] = ['ADMIN', 'USER'];
const SORT_VALUES: readonly AdminUserSort[] = ['newest', 'oldest', 'name', 'lastLogin'];

/** The URL keys, kept short because these end up in pasted links. */
type FilterParam = 'q' | 'status' | 'role' | 'sort' | 'page';

/**
 * `value` when the vocabulary admits it, the empty string when it does not.
 *
 * A `find` rather than a cast: `value as T` would compile and then hand the
 * server a filter it rejects, which is precisely the failure this guards.
 */
function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | '' {
  return allowed.find((entry) => entry === value) ?? '';
}

function readPage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function readFilters(params: URLSearchParams): AdminUserFilters {
  return {
    page: readPage(params.get('page')),
    search: params.get('q') ?? '',
    status: oneOf(STATUS_VALUES, params.get('status')),
    platformRole: oneOf(ROLE_VALUES, params.get('role')),
    // Sort has no "unset" state — the server defaults to newest and so does the
    // control, so an unreadable value resolves to the same thing as an absent one.
    sort: SORT_VALUES.find((entry) => entry === params.get('sort')) ?? 'newest',
  };
}

// ---------------------------------------------------------------------------
// Shared pills
// ---------------------------------------------------------------------------

/*
 * Both badges below are exported because the account detail screen shows the
 * same two facts about the same account, and a status that is amber on one
 * screen and grey on the next teaches an operator to distrust the colour. They
 * live here rather than in `components/owner/StatusBadge.tsx` because nothing
 * on the tenant surface has either concept: a workspace never sees a platform
 * role, and a member's own account status is not something their colleagues are
 * shown.
 */

const ACCOUNT_STATUS_TONES: Record<UserStatus, BadgeTone> = {
  ACTIVE: 'success',
  // Invited is amber for the same reason a pending appointment is: somebody is
  // waiting on somebody else, and nothing is wrong yet.
  INVITED: 'warning',
  SUSPENDED: 'danger',
  // Deactivated is grey rather than red. It is the deliberate end of an
  // account's life, not a fault to be chased.
  DEACTIVATED: 'neutral',
};

const ACCOUNT_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
};

export function AccountStatusBadge({ status }: { status: UserStatus }): JSX.Element {
  return (
    <Badge tone={ACCOUNT_STATUS_TONES[status]} dot>
      {ACCOUNT_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * Administrator or member.
 *
 * "Administrator" rather than the raw `ADMIN`, and it carries a shield: this is
 * the column an operator scans down when they want to know who holds the keys
 * to the deployment, and it has to be findable at a glance rather than read
 * word by word.
 */
export function PlatformRoleBadge({ role }: { role: PlatformRole }): JSX.Element {
  return role === 'ADMIN' ? (
    <Badge tone="brand">
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      Administrator
    </Badge>
  ) : (
    <Badge tone="neutral">Member</Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminUsersPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  /*
   * The signed-in operator's own clock, not any workspace's.
   *
   * Every management screen renders in the workspace timezone, because a 9am
   * appointment means 9am where the clinic is. This register spans every
   * workspace on the platform at once, so there is no single workspace zone to
   * use and picking one would misdate the other forty-nine rows. An operator
   * comparing "last seen" down a column needs one consistent clock, and
   * `useAuth().user` carries no timezone field, so the browser's zone is both
   * the only available answer and the right one.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  /**
   * Merges a change into the query string.
   *
   * `replace` rather than push: a search box that pushed a history entry per
   * keystroke would turn the back button into an undo-typing key, and the way
   * out of a filtered register would be twenty presses away.
   */
  const setFilters = useCallback(
    (patch: Partial<Record<FilterParam, string>>): void => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') next.delete(key);
            else next.set(key, value);
          }
          // Any change but a page change returns the reader to page one. Page
          // four of a narrower result set is usually past the end, and an empty
          // table reads as "nobody matches" rather than "you are too far in".
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /*
   * The URL updates on every keystroke; the request does not.
   *
   * Debouncing the *request* rather than the URL keeps the input responsive and
   * the link shareable while still spending one call per settled term — this
   * endpoint is rate limited per IP, and a call per character both wastes that
   * budget and produces results that flicker between prefixes.
   */
  const debouncedSearch = useDebouncedValue(filters.search);
  const requestFilters = useMemo<AdminUserFilters>(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );

  // The same object feeds the key and the query string, so the cache entry and
  // the request it caches cannot describe different filters.
  const scope = adminUserScope(requestFilters);

  const usersQuery = useQuery({
    queryKey: adminKeys.users(scope),
    queryFn: () => fetchAdminUsers(requestFilters),
    // Holds the current page on screen while the next one loads. Without it the
    // table blanks to a skeleton on every page click, and a register being
    // paged through flashes white six times on the way to page seven.
    placeholderData: (previous) => previous,
  });

  const rows = usersQuery.data?.items ?? [];

  // Sort is excluded deliberately: it never hides anyone, so an empty result
  // under a non-default sort is still "there are no accounts", not "your
  // filters are too narrow".
  const hasFilters = filters.search !== '' || filters.status !== '' || filters.platformRole !== '';

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account that can sign in to this deployment, whether or not it belongs to a workspace. Customers who book with a workspace are not accounts and never appear here."
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={filters.search}
            placeholder="Email or name"
            onChange={(value) => setFilters({ q: value })}
          />
          <FilterField label="Status">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.status}
                onChange={(event) => setFilters({ status: event.target.value })}
                options={STATUS_OPTIONS}
              />
            )}
          </FilterField>
          <FilterField label="Platform role">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.platformRole}
                onChange={(event) => setFilters({ role: event.target.value })}
                options={ROLE_OPTIONS}
              />
            )}
          </FilterField>
          <FilterField label="Sort by">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.sort}
                onChange={(event) => setFilters({ sort: event.target.value })}
                options={SORT_OPTIONS}
              />
            )}
          </FilterField>
        </FilterBar>
      </PageHeader>

      <Card>
        <DataState
          isPending={usersQuery.isPending}
          isError={usersQuery.isError}
          error={usersQuery.error}
          onRetry={() => void usersQuery.refetch()}
          isEmpty={rows.length === 0}
          columns={7}
          empty={
            <EmptyState
              icon={<UsersRound className="size-6" aria-hidden="true" />}
              // The two are different findings and must not share a sentence:
              // "nothing matches" is a filter to loosen, "no accounts" is a
              // deployment nobody has registered on yet.
              title={hasFilters ? 'No account matches' : 'No accounts yet'}
              description={
                hasFilters
                  ? 'Try a different search term, or widen the status and role filters.'
                  : 'Nobody has registered on this deployment. The first account is created by signing up, not from here — the admin surface reads accounts and changes their standing, it does not create them.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="secondary"
                    onClick={() => setFilters({ q: '', status: '', role: '' })}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Every account on this platform, with its role, standing and workspace count.">
              <THead>
                <Tr>
                  <Th>Person</Th>
                  <Th>Platform role</Th>
                  <Th>Status</Th>
                  <Th align="right">Workspaces</Th>
                  <Th>Email verified</Th>
                  <Th>Last seen</Th>
                  <Th>Joined</Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((account) => (
                  <Tr key={account.id}>
                    <Td>
                      <span className="flex items-center gap-3">
                        {/* Decorative: the name beside it is the label. */}
                        <Avatar name={account.fullName} size="sm" />
                        <span className="min-w-0">
                          <Link
                            to={`/admin/users/${account.id}`}
                            className="block truncate rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            {account.fullName}
                          </Link>
                          <span className="block truncate text-xs text-fg-muted">
                            {account.email}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <PlatformRoleBadge role={account.platformRole} />
                    </Td>
                    <Td>
                      <AccountStatusBadge status={account.status} />
                    </Td>
                    <Td numeric>
                      <span className="font-medium text-fg">
                        {formatNumber(account.workspaceCount)}
                      </span>
                      {account.ownedWorkspaceCount > 0 ? (
                        <span className="block text-xs text-fg-muted">
                          {formatNumber(account.ownedWorkspaceCount)} owned
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={account.emailVerified ? 'success' : 'neutral'} dot>
                        {account.emailVerified ? 'Verified' : 'Unverified'}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {account.lastLoginAt ? formatRelative(account.lastLoginAt, zone) : '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm tabular-nums text-fg-secondary">
                        {formatDate(account.createdAt, zone)}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {usersQuery.data ? (
            <Pagination
              meta={usersQuery.data.meta}
              onPageChange={(next) => setFilters({ page: String(next) })}
              itemLabel="accounts"
            />
          ) : null}
        </DataState>
      </Card>
    </>
  );
}
