import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout';
import { DataState, MembershipStatusBadge, SearchField, ownerKeys } from '@/components/owner';
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  TBody,
  THead,
  Table,
  TableContainer,
  Tabs,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { formatDate } from '@/lib/format';
import { PERMISSIONS, SYSTEM_ROLE_LABELS, isSystemRoleKey } from '@/lib/permissions';
import type { Role, WorkspaceMember } from '@/types/api';

/**
 * Who belongs to this workspace, and what each role may do.
 *
 * Read-only on purpose: the API exposes `GET /workspace/members` and
 * `GET /workspace/roles` and nothing else — there is no invite, role-change or
 * removal endpoint on this version of the contract. Rather than render controls
 * that would 404, the page says plainly where those changes are made.
 */
export default function MembersPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [search, setSearch] = useState('');

  const membersQuery = useQuery({
    queryKey: ownerKeys.members(activeBusinessId),
    queryFn: () => api.get<WorkspaceMember[]>('/workspace/members'),
    enabled: can(PERMISSIONS.MEMBERS_READ),
  });

  const rolesQuery = useQuery({
    queryKey: ownerKeys.roles(activeBusinessId),
    queryFn: () => api.get<Role[]>('/workspace/roles'),
    enabled: tab === 'roles' && can(PERMISSIONS.ROLES_READ),
  });

  const term = search.trim().toLowerCase();
  const members = (membersQuery.data ?? []).filter((member) => {
    if (term === '') return true;
    const haystack =
      `${member.user.firstName} ${member.user.lastName} ${member.user.email} ${member.role.name}`.toLowerCase();
    return haystack.includes(term);
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="Everyone with access to this workspace, and the permissions behind each role."
      >
        <div className="flex flex-col gap-4">
          <Tabs
            label="Workspace access"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: 'members', label: 'People', icon: <UsersRound className="size-4" /> },
              { value: 'roles', label: 'Roles', icon: <ShieldCheck className="size-4" /> },
            ]}
          />
          {tab === 'members' ? (
            <SearchField
              label="Search members"
              value={search}
              placeholder="Name, email or role"
              onChange={setSearch}
            />
          ) : null}
        </div>
      </PageHeader>

      {tab === 'members' ? (
        <Card>
          <DataState
            isPending={membersQuery.isPending}
            isError={membersQuery.isError}
            error={membersQuery.error}
            onRetry={() => void membersQuery.refetch()}
            isEmpty={members.length === 0}
            columns={5}
            empty={
              <EmptyState
                icon={<UsersRound className="size-6" aria-hidden="true" />}
                title={term === '' ? 'No members listed' : 'Nobody matches that search'}
                description={
                  term === ''
                    ? 'This workspace has no members the API will show you.'
                    : 'Try a different name, email or role.'
                }
              />
            }
          >
            <TableContainer>
              <Table caption="Members of this workspace">
                <THead>
                  <Tr>
                    <Th>Person</Th>
                    <Th>Role</Th>
                    <Th>Staff profile</Th>
                    <Th>Joined</Th>
                    <Th>Status</Th>
                  </Tr>
                </THead>
                <TBody>
                  {members.map((member) => (
                    <Tr key={member.id}>
                      <Td>
                        <span className="flex items-center gap-3">
                          <Avatar
                            name={`${member.user.firstName} ${member.user.lastName}`}
                            src={member.user.avatarUrl}
                            size="sm"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg">
                              {member.user.firstName} {member.user.lastName}
                            </span>
                            <span className="block truncate text-xs text-fg-muted">
                              {member.user.email}
                            </span>
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <Badge tone="brand">
                          {isSystemRoleKey(member.role.key)
                            ? SYSTEM_ROLE_LABELS[member.role.key]
                            : member.role.name}
                        </Badge>
                      </Td>
                      <Td>
                        <span className="text-sm text-fg-secondary">
                          {member.staffProfile?.displayName ?? 'Not bookable'}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-sm tabular-nums text-fg-secondary">
                          {member.joinedAt ? formatDate(member.joinedAt, activeTimezone) : '—'}
                        </span>
                      </Td>
                      <Td>
                        <MembershipStatusBadge status={member.status} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableContainer>
          </DataState>

          <CardBody className="border-t border-border">
            <p className="text-xs leading-relaxed text-fg-muted">
              Inviting someone, changing a role or removing access are not part of this version of
              the API, so they cannot be done from here.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            as="h2"
            title="Roles"
            description="What each role in this workspace is allowed to do. Permissions are grouped by the area they govern."
          />
          <DataState
            isPending={rolesQuery.isPending}
            isError={rolesQuery.isError}
            error={rolesQuery.error}
            onRetry={() => void rolesQuery.refetch()}
            isEmpty={(rolesQuery.data ?? []).length === 0}
            rows={3}
            columns={2}
            empty={
              <EmptyState
                icon={<ShieldCheck className="size-6" aria-hidden="true" />}
                title="No roles to show"
                description="Reading roles needs the roles permission, which your own role does not hold."
              />
            }
          >
            <CardBody className="flex flex-col gap-6">
              {(rolesQuery.data ?? []).map((role) => (
                <section key={role.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-fg">{role.name}</h3>
                    {role.isSystem ? <Badge tone="neutral">Built in</Badge> : null}
                    <Badge tone="info">{role.permissions.length} permissions</Badge>
                  </div>
                  {role.description ? (
                    <p className="text-sm text-fg-muted">{role.description}</p>
                  ) : null}
                  <ul className="flex flex-wrap gap-1.5">
                    {role.permissions.map((permission) => (
                      <li key={permission.id}>
                        <span
                          title={permission.description}
                          className="inline-flex rounded-full border border-border bg-surface-sunken px-2 py-0.5 font-mono text-[0.6875rem] text-fg-secondary"
                        >
                          {permission.key}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardBody>
          </DataState>
        </Card>
      )}
    </>
  );
}
