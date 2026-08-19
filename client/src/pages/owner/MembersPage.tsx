import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, ShieldX, UserPlus, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  MembershipStatusBadge,
  SearchField,
  ownerKeys,
  useDebouncedValue,
} from '@/components/owner';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Pagination,
  Select,
  Skeleton,
  Switch,
  TBody,
  THead,
  Table,
  TableContainer,
  Tabs,
  Td,
  Th,
  Tr,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { formatDate, formatRelative, humanizeEnum } from '@/lib/format';
import {
  PERMISSIONS,
  SYSTEM_ROLE_LABELS,
  isSystemRoleKey,
  type PermissionKey,
} from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type {
  MemberFilters,
  MemberPermissionOverride,
  MemberPermissions,
  MemberRecord,
  MembershipPermissionEffect,
  Permission,
  Role,
} from '@/types/api';
import { MEMBER_LISTABLE_STATUSES } from '@/types/api';
import {
  fetchMemberPermissions,
  fetchMembers,
  inviteMember,
  memberInvalidationKeys,
  memberScope,
  removeMember,
  replaceMemberPermissions,
  updateMember,
  workspaceKeys,
} from './workspaceApi';

/**
 * Who belongs to this workspace, what each of them may do, and how that changes.
 *
 * Until `/api/v1/members` shipped, a workspace could not gain a second member at
 * all: the only membership row anybody had was the one workspace creation wrote
 * for the owner. Three of the four built-in roles were therefore unreachable —
 * defined, seeded, enforced by the server, and held by nobody. This page is what
 * makes them reachable, which is why the invite drawer spends as much room on
 * *what the role can do* as on the address it is sent to. Inviting somebody is
 * granting authority over a diary, a customer list and, for two of the roles,
 * over other people's access.
 *
 * The server refuses several changes outright, and this screen disables them
 * with the server's own wording rather than letting somebody click into a 409.
 * Three of the four refusals are knowable from a row — the owner's membership is
 * immutable, nobody may act on their own, and a removed row is gone from the
 * default scope entirely — and are mirrored below in `restrictionFor`. The
 * fourth is not: "the last member who can manage roles" needs every membership's
 * overrides read under a row lock, which is exactly the race the server closes
 * and exactly the answer a client cannot compute. That one arrives as a 409 and
 * is surfaced verbatim, because the message names the way out.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The refusal wording, copied from `assertNotOwner` and `assertNotSelf` in
 * members.service.ts.
 *
 * Copied rather than paraphrased on purpose. Somebody who reads "you cannot
 * remove your own membership" here, clicks anyway on a different route and gets
 * the same sentence from the API has learned one rule; two phrasings of one rule
 * reads as two different problems.
 */
const OWNER_REFUSAL = {
  change: "The workspace owner's membership cannot be changed. Transfer ownership first.",
  remove: "The workspace owner's membership cannot be removed. Transfer ownership first.",
  override: "The workspace owner's membership cannot be overridden. Transfer ownership first.",
} as const;

const SELF_REFUSAL = {
  change:
    'You cannot change your own membership. Ask another member with the right to manage roles.',
  remove:
    'You cannot remove your own membership. Ask another member with the right to manage roles.',
  override:
    'You cannot change the permissions on your own membership. Ask another member with the ' +
    'right to manage roles.',
} as const;

/**
 * A removed membership is soft deleted, so the server's loader cannot see it at
 * all and every write against it answers 404 rather than a refusal. Saying
 * "not found" to somebody looking straight at the row would be useless, so the
 * screen explains the state instead.
 */
const REMOVED_REFUSAL =
  'This person has left the workspace. Their membership is closed and nothing on it can be ' +
  'edited — invite the address again to give them access, which creates a fresh membership.';

/** The status the server refuses to activate from this side. */
const INVITED_REFUSAL =
  'That invitation has not been accepted yet. It becomes active when the invited person ' +
  'accepts it, and can be withdrawn by removing them.';

type MemberAction = keyof typeof OWNER_REFUSAL;

/**
 * Category headings for the permission catalogue, in the order the server's
 * `PERMISSION_CATALOGUE` declares them.
 *
 * Order is fixed here rather than taken from the response because the response
 * is assembled from role rows and carries no ordering of its own; alphabetical
 * would put Appointments above Workspace, which is not how anybody reasons about
 * a role. A category this list does not name still renders — see
 * `groupPermissions` — so a category added on the server appears at the end
 * instead of disappearing.
 */
const CATEGORY_ORDER: readonly string[] = [
  'workspace',
  'people',
  'structure',
  'catalogue',
  'availability',
  'customers',
  'appointments',
  'booking',
  'communication',
  'insight',
  'integration',
];

const CATEGORY_LABELS: Record<string, string> = {
  workspace: 'Workspace',
  people: 'People and access',
  structure: 'Locations, teams and staff',
  catalogue: 'Services and resources',
  availability: 'Availability',
  customers: 'Customers',
  appointments: 'Appointments',
  booking: 'Booking links and waitlist',
  communication: 'Notifications and automations',
  insight: 'Analytics, reports and audit',
  integration: 'Webhooks',
};

/**
 * The permissions worth naming in plain English before somebody is invited.
 *
 * Not the whole catalogue: a list of sixty keys is a list nobody reads, and the
 * consequential question is "will this person be able to act on other people,
 * on money, or on records they were not part of". These six are the ones where
 * the answer is yes. The full list is still on screen underneath — this is a
 * summary of it, never a substitute.
 */
const AUTHORITY_NOTES: ReadonlyArray<{ permission: PermissionKey; note: string }> = [
  { permission: PERMISSIONS.ROLES_MANAGE, note: 'Change what every role in this workspace can do' },
  { permission: PERMISSIONS.MEMBERS_INVITE, note: 'Invite other people into this workspace' },
  { permission: PERMISSIONS.MEMBERS_REMOVE, note: "Remove other people's access" },
  { permission: PERMISSIONS.APPOINTMENTS_READ, note: 'See the whole diary, not only their own' },
  { permission: PERMISSIONS.CUSTOMERS_READ, note: 'Read every customer record and note' },
  { permission: PERMISSIONS.REPORTS_EXPORT, note: 'Export reports out of the workspace' },
];

/**
 * The keys that make a role a management role.
 *
 * A change that adds or drops any of these is what triggers a confirmation
 * step: promoting a receptionist to manager hands them authority over their
 * colleagues' access, and demoting a manager takes it away mid-shift.
 */
const MANAGEMENT_KEYS: readonly PermissionKey[] = [
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.MEMBERS_INVITE,
  PERMISSIONS.MEMBERS_UPDATE,
  PERMISSIONS.MEMBERS_REMOVE,
];

const EFFECT_OPTIONS: SelectOption[] = [
  { value: '', label: 'Inherit from role' },
  { value: 'GRANT', label: 'Grant' },
  { value: 'DENY', label: 'Deny' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roleLabel(role: { key: string; name: string }): string {
  return isSystemRoleKey(role.key) ? SYSTEM_ROLE_LABELS[role.key] : role.name;
}

/** Why a control on this member is unavailable, or null when it is not. */
function restrictionFor(
  member: MemberRecord,
  action: MemberAction,
  viewerUserId: string | null,
): string | null {
  // Ordered the way the server reaches them: the loader runs before any guard,
  // and a soft-deleted row never gets past it.
  if (member.status === 'REMOVED') return REMOVED_REFUSAL;
  if (viewerUserId !== null && member.user.id === viewerUserId) return SELF_REFUSAL[action];
  if (member.isOwner) return OWNER_REFUSAL[action];
  return null;
}

interface PermissionGroup {
  category: string;
  label: string;
  permissions: Permission[];
}

/**
 * Groups a set of permissions under their category headings.
 *
 * Unknown categories are kept and sorted to the end rather than dropped: this
 * client's `CATEGORY_ORDER` is a display preference, and a permission the server
 * has added under a heading nobody has named yet must still be visible, or an
 * operator would be editing a set they cannot see all of.
 */
function groupPermissions(permissions: Permission[]): PermissionGroup[] {
  const byCategory = new Map<string, Permission[]>();
  for (const permission of permissions) {
    const bucket = byCategory.get(permission.category);
    if (bucket) bucket.push(permission);
    else byCategory.set(permission.category, [permission]);
  }

  const rank = (category: string): number => {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };

  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      label: CATEGORY_LABELS[category] ?? humanizeEnum(category),
      permissions: [...items].sort((a, b) => a.key.localeCompare(b.key)),
    }));
}

/**
 * The whole permission catalogue, assembled from the roles response.
 *
 * There is no endpoint that lists permissions on their own, and the workspace's
 * Business Owner role is seeded with every one of them, so the union across
 * roles is the catalogue. The caveat is worth knowing rather than hiding: if
 * somebody edits the owner role to drop a key, that key stops appearing in the
 * override editor even though the server would still accept it. The editor
 * therefore also renders any override whose key is absent here — see
 * `OverrideEditor` — so an existing exception can never become invisible and
 * uneditable.
 */
function permissionCatalogue(roles: Role[]): Permission[] {
  const byKey = new Map<string, Permission>();
  for (const role of roles) {
    for (const permission of role.permissions) byKey.set(permission.key, permission);
  }
  return [...byKey.values()];
}

type ManagementDelta = 'grants' | 'removes' | 'both' | 'none';

/** Whether swapping roles hands management rights over, takes them away, or neither. */
function managementDelta(from: Role | undefined, to: Role | undefined): ManagementDelta {
  if (!from || !to) return 'none';
  const before = new Set(from.permissions.map((permission) => permission.key));
  const after = new Set(to.permissions.map((permission) => permission.key));

  const gained = MANAGEMENT_KEYS.some((key) => !before.has(key) && after.has(key));
  const lost = MANAGEMENT_KEYS.some((key) => before.has(key) && !after.has(key));

  if (gained && lost) return 'both';
  if (gained) return 'grants';
  if (lost) return 'removes';
  return 'none';
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A panel-scale version of `ProtectedRoute`'s refusal, in the same vocabulary. */
function AreaUnavailable({
  title,
  description,
}: {
  title: string;
  description: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border px-4 py-6">
      <EmptyState
        icon={<ShieldX className="size-6" aria-hidden="true" />}
        title={title}
        description={description}
      />
    </div>
  );
}

/** A reason a control is unavailable, next to the control it explains. */
function Restriction({ reason }: { reason: string }): JSX.Element {
  return <p className="text-xs leading-relaxed text-warning-text">{reason}</p>;
}

/** The permission keys a role carries, grouped and described. */
function PermissionGroups({ permissions }: { permissions: Permission[] }): JSX.Element {
  const groups = groupPermissions(permissions);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {group.label}
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {group.permissions.map((permission) => (
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
    </div>
  );
}

/**
 * What holding one role actually lets a person do.
 *
 * Rendered wherever a role is being chosen for somebody. The plain-English lines
 * come first because they are the part an inviter is accountable for; the key
 * list underneath is the exhaustive answer for anybody who wants it.
 */
function RoleAuthority({ role }: { role: Role }): JSX.Element {
  const held = new Set(role.permissions.map((permission) => permission.key));
  const notable = AUTHORITY_NOTES.filter((entry) => held.has(entry.permission));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{roleLabel(role)}</h3>
        <Badge tone="info">{role.permissions.length} permissions</Badge>
      </div>

      {role.description ? (
        <p className="text-sm leading-relaxed text-fg-secondary">{role.description}</p>
      ) : null}

      {notable.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            This role can
          </p>
          <ul className="flex flex-col gap-1">
            {notable.map((entry) => (
              <li key={entry.permission} className="flex gap-2 text-sm text-fg-secondary">
                <span aria-hidden="true" className="text-warning-text">
                  •
                </span>
                {entry.note}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-fg-secondary">
          This role acts only on its own work. It cannot change anybody else&apos;s access, read the
          whole diary, or take records out of the workspace.
        </p>
      )}

      <PermissionGroups permissions={role.permissions} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permission overrides
// ---------------------------------------------------------------------------

/**
 * The per-member exceptions the server honours, as one editable set.
 *
 * `PUT /members/:id/permissions` is a full replacement rather than a patch, so
 * this editor holds the whole set in local state and sends all of it: a merge
 * endpoint could not express "remove this DENY" at all. The draft is seeded from
 * the response and reset whenever the drawer reopens, so an abandoned edit never
 * survives to be saved against somebody else.
 *
 * Three states per key, and each row states which one it is in three ways at
 * once: the select's own value on the right, a tint across the row, and an
 * Allowed/Blocked pill beside the key. Colour alone would be unreadable to a
 * colour-blind operator, and the select alone reads as a form control rather
 * than as a statement about what somebody can actually do — which is the
 * question anybody opens this panel to answer.
 */
function OverrideEditor({
  member,
  catalogue,
  open,
  onClose,
  canEdit,
}: {
  member: MemberRecord | null;
  catalogue: Permission[];
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
}): JSX.Element {
  const { activeBusinessId, user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<string, MembershipPermissionEffect>>({});

  const membershipId = member?.id ?? '';

  const permissionsQuery = useQuery({
    queryKey: workspaceKeys.memberPermissions(activeBusinessId, membershipId),
    queryFn: () => fetchMemberPermissions(membershipId),
    enabled: open && membershipId !== '',
  });

  const loaded = permissionsQuery.data;

  /*
   * Seeded from the server's answer on every open, on every change of member,
   * and again whenever that answer changes.
   *
   * All three matter. Without `open` in the dependencies, reopening the same
   * member while their permissions are still cached would leave the previous
   * session's abandoned edits sitting in the draft, ready to be saved by
   * somebody who thinks they are looking at the stored set. The third case is
   * what makes a save settle: the mutation writes the fresh record into the
   * cache and the draft follows it, rather than holding what was just sent.
   */
  useEffect(() => {
    if (!open) return;
    const next: Record<string, MembershipPermissionEffect> = {};
    for (const override of loaded?.overrides ?? []) next[override.permission] = override.effect;
    setDraft(next);
  }, [open, membershipId, loaded]);

  const save = useMutation<MemberPermissions, unknown, MemberPermissionOverride[]>({
    mutationFn: (overrides) => replaceMemberPermissions(membershipId, overrides),
    onSuccess: (result) => {
      queryClient.setQueryData(
        workspaceKeys.memberPermissions(activeBusinessId, membershipId),
        result,
      );
      // The viewer may have just changed their own effective permissions by
      // proxy — they cannot edit their own membership, but they can edit the
      // membership of somebody whose role they are also in the middle of
      // reading — so the member list is refetched rather than patched.
      for (const key of memberInvalidationKeys(activeBusinessId)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast({ tone: 'success', title: 'Permission overrides saved' });
      onClose();
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not save these overrides',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const roleGrants = useMemo(
    () => new Set(loaded?.rolePermissions ?? []),
    [loaded?.rolePermissions],
  );

  /*
   * The catalogue, plus any override whose key the catalogue does not carry.
   *
   * The second half is not hypothetical tidiness: the catalogue is assembled
   * from the roles response, so a key that no role currently grants is missing
   * from it while the override on this member is still live and still enforced.
   * Dropping the row would hide an exception that cannot then be cleared.
   */
  const rows = useMemo(() => {
    const known = new Set(catalogue.map((permission) => permission.key));
    const orphans = (loaded?.overrides ?? [])
      .filter((override) => !known.has(override.permission))
      .map<Permission>((override) => ({
        id: `unlisted-${override.permission}`,
        key: override.permission,
        category: 'unlisted',
        description: 'No role in this workspace grants this permission today.',
        createdAt: '',
        updatedAt: '',
      }));
    return groupPermissions([...catalogue, ...orphans]);
  }, [catalogue, loaded?.overrides]);

  const grantCount = Object.values(draft).filter((effect) => effect === 'GRANT').length;
  const denyCount = Object.values(draft).filter((effect) => effect === 'DENY').length;

  const restriction = member ? restrictionFor(member, 'override', user?.id ?? null) : null;
  const editable = canEdit && restriction === null;

  const submit = (): void => {
    const overrides = Object.entries(draft).map<MemberPermissionOverride>(
      ([permission, effect]) => ({
        permission,
        effect,
      }),
    );
    save.mutate(overrides);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={member ? `Permissions for ${member.user.fullName}` : 'Permissions'}
      description={
        member
          ? `Exceptions applied on top of ${roleLabel(member.role)}. A deny wins over everything.`
          : undefined
      }
      width="lg"
      footer={
        editable ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={save.isPending} disabled={!loaded}>
              Save overrides
            </Button>
          </>
        ) : undefined
      }
    >
      {permissionsQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : permissionsQuery.isError ? (
        <ErrorState
          error={permissionsQuery.error}
          onRetry={() => void permissionsQuery.refetch()}
        />
      ) : loaded ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-4">
            <p className="text-sm leading-relaxed text-fg-secondary">
              An override applies to this one person. A grant adds a permission their role does not
              carry; a deny takes one away and beats both the role and any grant. Leave a permission
              on <span className="font-medium text-fg">Inherit from role</span> and it follows{' '}
              {roleLabel(loaded.role)} as that role changes.
            </p>
            <p className="text-sm tabular-nums text-fg">
              {grantCount} granted · {denyCount} denied · {loaded.effectivePermissions.length}{' '}
              permissions in effect
            </p>
            {editable && (grantCount > 0 || denyCount > 0) ? (
              <div>
                <Button variant="secondary" size="sm" onClick={() => setDraft({})}>
                  Clear every override
                </Button>
              </div>
            ) : null}
          </div>

          {restriction ? <Restriction reason={restriction} /> : null}
          {!canEdit && restriction === null ? (
            <Restriction reason="Editing one person's exceptions changes the authorisation model, so it needs the roles:manage permission. Your role does not hold it, so this list is read-only." />
          ) : null}

          {rows.map((group) => (
            <section key={group.category} className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {group.label}
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border">
                {group.permissions.map((permission) => {
                  const effect = draft[permission.key];
                  const inherited = roleGrants.has(permission.key);
                  const allowed = effect === undefined ? inherited : effect === 'GRANT';

                  return (
                    <li
                      key={permission.key}
                      className={
                        effect === 'GRANT'
                          ? 'grid gap-2 border-b border-border bg-success-subtle px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center'
                          : effect === 'DENY'
                            ? 'grid gap-2 border-b border-border bg-danger-subtle px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center'
                            : 'grid gap-2 border-b border-border px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center'
                      }
                    >
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-fg">{permission.key}</span>
                          <Badge tone={allowed ? 'success' : 'neutral'} dot>
                            {allowed ? 'Allowed' : 'Blocked'}
                          </Badge>
                        </p>
                        <p className="text-xs leading-relaxed text-fg-muted">
                          {permission.description} · {roleLabel(loaded.role)}{' '}
                          {inherited ? 'grants this' : 'does not grant this'}.
                        </p>
                      </div>
                      <Select
                        selectSize="sm"
                        aria-label={`Override for ${permission.key}`}
                        disabled={!editable}
                        value={effect ?? ''}
                        onChange={(event) => {
                          const next = event.target.value;
                          setDraft((current) => {
                            const copy = { ...current };
                            if (next === '') delete copy[permission.key];
                            else copy[permission.key] = next as MembershipPermissionEffect;
                            return copy;
                          });
                        }}
                        options={EFFECT_OPTIONS}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// One member's access
// ---------------------------------------------------------------------------

interface AccessDrawerProps {
  member: MemberRecord | null;
  roles: Role[];
  rolesReadable: boolean;
  open: boolean;
  onClose: () => void;
  onRequestRoleChange: (member: MemberRecord, roleId: string, delta: ManagementDelta) => void;
  onRequestRemoval: (member: MemberRecord) => void;
  onOpenOverrides: (member: MemberRecord) => void;
  onSetStatus: (member: MemberRecord, status: 'ACTIVE' | 'SUSPENDED') => void;
  isSaving: boolean;
}

function AccessDrawer({
  member,
  roles,
  rolesReadable,
  open,
  onClose,
  onRequestRoleChange,
  onRequestRemoval,
  onOpenOverrides,
  onSetStatus,
  isSaving,
}: AccessDrawerProps): JSX.Element {
  const { activeTimezone, can, user } = useAuth();
  const [roleId, setRoleId] = useState('');

  useEffect(() => {
    if (open && member) setRoleId(member.role.id);
  }, [open, member]);

  const canUpdate = can(PERMISSIONS.MEMBERS_UPDATE);
  const canRemove = can(PERMISSIONS.MEMBERS_REMOVE);
  const canManageRoles = can(PERMISSIONS.ROLES_MANAGE);

  const changeBlock = member ? restrictionFor(member, 'change', user?.id ?? null) : null;
  const removeBlock = member ? restrictionFor(member, 'remove', user?.id ?? null) : null;

  const selectedRole = roles.find((role) => role.id === roleId);
  const currentRole = member ? roles.find((role) => role.id === member.role.id) : undefined;
  const delta = managementDelta(currentRole, selectedRole);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={member ? member.user.fullName : 'Member'}
      description={member?.user.email}
      width="lg"
    >
      {member ? (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-3">
            <Avatar name={member.user.fullName} src={member.user.avatarUrl} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-fg">{member.user.fullName}</p>
              <p className="truncate text-sm text-fg-muted">{member.user.email}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{roleLabel(member.role)}</Badge>
                <MembershipStatusBadge status={member.status} />
                {member.isOwner ? <Badge tone="accent">Workspace owner</Badge> : null}
              </div>
            </div>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Invited</dt>
              <dd className="text-fg">
                {member.invitedAt ? formatDate(member.invitedAt, activeTimezone) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Joined</dt>
              <dd className="text-fg">
                {member.joinedAt
                  ? `${formatDate(member.joinedAt, activeTimezone)} (${formatRelative(
                      member.joinedAt,
                      activeTimezone,
                    )})`
                  : 'Has not accepted yet'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Staff profile
              </dt>
              <dd className="text-fg">
                {member.staffProfile
                  ? `${member.staffProfile.displayName}${member.staffProfile.isBookable ? '' : ' (not bookable)'}`
                  : 'None — this person does not appear on the booking page'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Account</dt>
              <dd className="text-fg">{humanizeEnum(member.user.status)}</dd>
            </div>
          </dl>

          {/* --- Role ------------------------------------------------------ */}
          <section className="flex flex-col gap-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-fg">Role</h3>

            {!canUpdate ? (
              <AreaUnavailable
                title="Changing a role is not part of your role"
                description="Assigning somebody a different role needs the members:update permission, which your role in this workspace does not hold. An owner or manager can change that."
              />
            ) : changeBlock ? (
              <Restriction reason={changeBlock} />
            ) : !rolesReadable ? (
              <Restriction reason="Choosing a role needs the roles:read permission so the list of roles can be loaded. Your role does not hold it." />
            ) : (
              <>
                <Field label="Assigned role">
                  {(field) => (
                    <Select
                      {...field}
                      value={roleId}
                      onChange={(event) => setRoleId(event.target.value)}
                      options={roles.map((role) => ({ value: role.id, label: roleLabel(role) }))}
                    />
                  )}
                </Field>

                {selectedRole && selectedRole.id !== member.role.id ? (
                  <>
                    <RoleAuthority role={selectedRole} />
                    <div>
                      <Button
                        onClick={() => onRequestRoleChange(member, roleId, delta)}
                        loading={isSaving}
                      >
                        Change role
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-fg-muted">
                    Pick a different role to see what it would let this person do before anything is
                    applied.
                  </p>
                )}
              </>
            )}
          </section>

          {/* --- Status ---------------------------------------------------- */}
          <section className="flex flex-col gap-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-fg">Access</h3>

            {!canUpdate ? (
              <p className="text-xs leading-relaxed text-fg-muted">
                Suspending and restoring access needs the members:update permission.
              </p>
            ) : member.status === 'INVITED' ? (
              <Restriction reason={INVITED_REFUSAL} />
            ) : changeBlock ? (
              <p className="text-xs leading-relaxed text-fg-muted">
                Suspension is unavailable for the same reason as the role above.
              </p>
            ) : (
              <Switch
                checked={member.status === 'ACTIVE'}
                disabled={isSaving}
                onCheckedChange={(checked) => onSetStatus(member, checked ? 'ACTIVE' : 'SUSPENDED')}
                label="Can sign in to this workspace"
                description="Suspending keeps every record and every past appointment. The person stays in this list and can be restored here; their bookings are not reassigned, so a suspended provider still needs their diary cleared by hand."
              />
            )}
          </section>

          {/* --- Overrides -------------------------------------------------- */}
          <section className="flex flex-col gap-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-fg">Permission overrides</h3>
            <p className="text-sm leading-relaxed text-fg-secondary">
              Advanced. Grant or deny one permission for this person alone, without cloning a role
              for them. A deny beats both the role and any grant.
            </p>
            {/*
             * The owner and the viewer themselves can still be *read* here —
             * only the write is refused, and the editor says so where the save
             * button would be. A removed membership is different in kind: the
             * server's loader is paranoid, so the read itself answers 404, and
             * offering a button that can only produce an error state would be
             * worse than not offering one.
             */}
            {member.status === 'REMOVED' ? (
              <Restriction reason={REMOVED_REFUSAL} />
            ) : (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => onOpenOverrides(member)}
                  leadingIcon={<KeyRound className="size-4" aria-hidden="true" />}
                >
                  {canManageRoles ? 'Review overrides' : 'View overrides'}
                </Button>
              </div>
            )}
          </section>

          {/* --- Removal ---------------------------------------------------- */}
          <section className="flex flex-col gap-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-danger-text">Remove from workspace</h3>

            {!canRemove ? (
              <p className="text-xs leading-relaxed text-fg-muted">
                Removing somebody needs the members:remove permission, which your role does not
                hold.
              </p>
            ) : removeBlock ? (
              <Restriction reason={removeBlock} />
            ) : (
              <>
                <p className="text-sm leading-relaxed text-fg-secondary">
                  Their appointment history and every audit entry they wrote are kept. If they
                  deliver appointments, the workspace refuses the removal while any are still
                  upcoming.
                </p>
                <div>
                  <Button variant="danger" onClick={() => onRequestRemoval(member)}>
                    Remove {member.user.firstName}
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(255),
  roleId: z.string().min(1, 'Choose the role this person will hold.'),
  firstName: z.string().trim().max(100),
  lastName: z.string().trim().max(100),
});

type InviteFormValues = z.input<typeof inviteSchema>;

const INVITE_FIELDS = ['email', 'roleId', 'firstName', 'lastName'] as const;

const EMPTY_INVITE: InviteFormValues = { email: '', roleId: '', firstName: '', lastName: '' };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Panel =
  | { kind: 'none' }
  | { kind: 'invite' }
  | { kind: 'access'; memberId: string }
  | { kind: 'overrides'; memberId: string };

type Confirmation =
  | { kind: 'role'; member: MemberRecord; roleId: string; delta: ManagementDelta }
  | { kind: 'remove'; member: MemberRecord }
  | null;

export default function MembersPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can, user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [filters, setFilters] = useState<MemberFilters>({
    page: 1,
    search: '',
    status: '',
    roleId: '',
    includeRemoved: false,
  });
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const canInvite = can(PERMISSIONS.MEMBERS_INVITE);
  const canReadRoles = can(PERMISSIONS.ROLES_READ);
  const canManageRoles = can(PERMISSIONS.ROLES_MANAGE);

  const debouncedSearch = useDebouncedValue(filters.search);
  const requestFilters = useMemo<MemberFilters>(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );

  const membersQuery = useQuery({
    // The same object feeds the key and the query string, so a cache entry and
    // the request it caches cannot describe different filters.
    queryKey: workspaceKeys.members(activeBusinessId, memberScope(requestFilters)),
    queryFn: () => fetchMembers(requestFilters),
    // Holds the current page on screen while the next one loads, so paging does
    // not flash a skeleton between every click.
    placeholderData: (previous) => previous,
  });

  /*
   * The roles list feeds three things: the filter dropdown, the role picker, and
   * the permission catalogue the override editor is built from. It is fetched
   * once for all of them rather than per panel, and it changes far more slowly
   * than the membership list it describes.
   */
  const rolesQuery = useQuery({
    queryKey: ownerKeys.roles(activeBusinessId),
    queryFn: () => api.get<Role[]>('/workspace/roles'),
    enabled: canReadRoles,
    staleTime: 5 * 60_000,
  });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const catalogue = useMemo(() => permissionCatalogue(roles), [roles]);

  const invalidate = (): void => {
    for (const key of memberInvalidationKeys(activeBusinessId)) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const items = membersQuery.data?.items ?? [];

  /*
   * Panels hold an id and look the record up again on every render rather than
   * holding a copy. A member who has just been suspended, promoted or filtered
   * off the page must not go on being described by a snapshot taken before the
   * change — and a record that leaves the page closes its own drawer, which is
   * the honest outcome when the row it described is no longer in view.
   */
  const panelMember =
    panel.kind === 'access' || panel.kind === 'overrides'
      ? (items.find((member) => member.id === panel.memberId) ?? null)
      : null;

  // --- Mutations -----------------------------------------------------------

  const inviteForm = useForm<InviteFormValues>({
    // No `raw: true` here, unlike the customer form: this schema's only
    // transforms are the trim and lower-case on the address, and those are
    // exactly what should reach the API. The server lower-cases the column
    // anyway, so sending the raw value would only make the toast disagree with
    // the row that was written.
    resolver: zodResolver(inviteSchema),
    defaultValues: EMPTY_INVITE,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(
    inviteForm.setError,
    INVITE_FIELDS,
  );

  useEffect(() => {
    if (panel.kind !== 'invite') return;
    clearFormError();
    inviteForm.reset(EMPTY_INVITE);
  }, [panel.kind, inviteForm, clearFormError]);

  const invite = useMutation<MemberRecord, unknown, InviteFormValues>({
    mutationFn: (values) => inviteMember(values),
    onSuccess: (member) => {
      invalidate();
      toast({
        tone: 'success',
        title: `Invited ${member.user.email}`,
        description: `They will appear as invited until they accept. Their role will be ${roleLabel(member.role)}.`,
      });
      setPanel({ kind: 'none' });
    },
    onError: handleApiError,
  });

  const update = useMutation<
    MemberRecord,
    unknown,
    { membershipId: string; roleId?: string; status?: 'ACTIVE' | 'SUSPENDED'; message: string }
  >({
    mutationFn: ({ membershipId, roleId, status }) =>
      updateMember(membershipId, { ...(roleId ? { roleId } : {}), ...(status ? { status } : {}) }),
    onSuccess: (_member, variables) => {
      invalidate();
      toast({ tone: 'success', title: variables.message });
      setConfirmation(null);
    },
    onError: (error) => {
      /*
       * Shown verbatim, and this is the case the screen cannot pre-empt: the
       * last-holder-of-roles:manage guard reads every membership's overrides
       * under a row lock, so its answer only exists inside the transaction. The
       * message names the way out ("grant roles:manage to another active member
       * first"), which is more use than anything this page could invent.
       */
      toast({
        tone: 'error',
        title: 'Could not change this membership',
        description: isApiError(error) ? error.message : undefined,
      });
      setConfirmation(null);
    },
  });

  const remove = useMutation<void, unknown, MemberRecord>({
    mutationFn: (member) => removeMember(member.id),
    onSuccess: (_result, member) => {
      invalidate();
      toast({
        tone: 'success',
        title: `Removed ${member.user.fullName}`,
        description: 'Their history stays. Invite the same address to bring them back.',
      });
      setConfirmation(null);
      setPanel({ kind: 'none' });
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this member',
        description: isApiError(error) ? error.message : undefined,
      });
      setConfirmation(null);
    },
  });

  // --- Derived -------------------------------------------------------------

  const hasFilters =
    filters.search !== '' ||
    filters.status !== '' ||
    filters.roleId !== '' ||
    filters.includeRemoved;

  const patchFilters = (patch: Partial<MemberFilters>): void => {
    // Any change but a page change returns the reader to page one: page four of
    // a narrower list is usually past the end, and an empty table then reads as
    // "nobody matches" rather than "you are too far in".
    setFilters((current) => ({ ...current, ...patch, ...('page' in patch ? {} : { page: 1 }) }));
  };

  const inviteRole = roles.find((role) => role.id === inviteForm.watch('roleId'));

  /*
   * The wording for whichever consequential change is waiting on a confirmation.
   *
   * `destructive` is decided here rather than at the dialog, because the answer
   * depends on which direction the change goes: a promotion is consequential but
   * adds something, while a demotion takes authority away from somebody relying
   * on it right now, and a removal ends their access outright.
   */
  const confirmationCopy = ((): {
    title: string;
    description: string;
    label: string;
    destructive: boolean;
  } | null => {
    if (!confirmation) return null;

    if (confirmation.kind === 'remove') {
      return {
        title: `Remove ${confirmation.member.user.fullName}?`,
        description:
          'They lose access to this workspace immediately. Their appointment history, the notes ' +
          'they wrote and every audit entry naming them are all kept, and any staff profile is ' +
          'archived alongside the membership. Inviting the same address later creates a new ' +
          'membership that starts from its role alone, with none of the overrides this one had.',
        label: 'Remove member',
        destructive: true,
      };
    }

    const nextRole = roles.find((role) => role.id === confirmation.roleId);
    const name = confirmation.member.user.fullName;
    const to = nextRole ? roleLabel(nextRole) : 'the selected role';

    return {
      title: `Move ${name} to ${to}?`,
      description:
        confirmation.delta === 'grants'
          ? `${to} carries authority over other people: whoever holds it can act on colleagues' access to this workspace. ${name} will be able to do that from the moment this is saved.`
          : confirmation.delta === 'removes'
            ? `${name} currently holds authority over other people's access. ${to} does not carry it, so they will lose the ability to invite, change or remove colleagues — including anything they are part-way through.`
            : `${to} both adds and removes authority over other people compared with ${roleLabel(confirmation.member.role)}. Check the permission list on the previous screen before saving.`,
      label: 'Change role',
      destructive: confirmation.delta !== 'grants',
    };
  })();

  const statusOptions: SelectOption[] = [
    { value: '', label: 'Every status' },
    ...MEMBER_LISTABLE_STATUSES.map((status) => ({
      value: status,
      label: humanizeEnum(status),
    })),
  ];

  return (
    <>
      <PageHeader
        title="Members"
        description="Everyone with access to this workspace, the role each of them holds, and the permissions behind those roles."
        actions={
          canInvite ? (
            <Button
              onClick={() => setPanel({ kind: 'invite' })}
              leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
            >
              Invite someone
            </Button>
          ) : null
        }
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
            <FilterBar>
              <SearchField
                label="Search"
                value={filters.search}
                placeholder="Name or email"
                onChange={(value) => patchFilters({ search: value })}
              />
              <FilterField label="Status">
                {({ id }) => (
                  <Select
                    id={id}
                    selectSize="sm"
                    value={filters.status}
                    onChange={(event) =>
                      patchFilters({ status: event.target.value as MemberFilters['status'] })
                    }
                    options={statusOptions}
                  />
                )}
              </FilterField>
              {canReadRoles ? (
                <FilterField label="Role" className="min-w-[11rem]">
                  {({ id }) => (
                    <Select
                      id={id}
                      selectSize="sm"
                      value={filters.roleId}
                      onChange={(event) => patchFilters({ roleId: event.target.value })}
                      options={[
                        { value: '', label: 'Every role' },
                        ...roles.map((role) => ({ value: role.id, label: roleLabel(role) })),
                      ]}
                    />
                  )}
                </FilterField>
              ) : null}
              <div className="pb-1">
                <Switch
                  checked={filters.includeRemoved}
                  onCheckedChange={(checked) => patchFilters({ includeRemoved: checked })}
                  label="Include people who have left"
                />
              </div>
            </FilterBar>
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
            isEmpty={items.length === 0}
            columns={6}
            empty={
              <EmptyState
                icon={<UsersRound className="size-6" aria-hidden="true" />}
                title={hasFilters ? 'Nobody matches these filters' : 'No members listed'}
                description={
                  hasFilters
                    ? 'Try a different name, status or role, or clear the filters.'
                    : 'This workspace has no members the API will show you.'
                }
                action={
                  hasFilters ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setFilters({
                          page: 1,
                          search: '',
                          status: '',
                          roleId: '',
                          includeRemoved: false,
                        })
                      }
                    >
                      Clear filters
                    </Button>
                  ) : canInvite ? (
                    <Button
                      onClick={() => setPanel({ kind: 'invite' })}
                      leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
                    >
                      Invite someone
                    </Button>
                  ) : null
                }
              />
            }
          >
            <TableContainer>
              <Table caption="Members of this workspace, oldest membership first.">
                <THead>
                  <Tr>
                    <Th>Person</Th>
                    <Th>Role</Th>
                    <Th>Staff profile</Th>
                    <Th>Joined</Th>
                    <Th>Status</Th>
                    <Th align="right">
                      <span className="mf-sr-only">Actions</span>
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {items.map((member) => (
                    <Tr key={member.id} interactive>
                      <Td>
                        <button
                          type="button"
                          onClick={() => setPanel({ kind: 'access', memberId: member.id })}
                          className="flex items-center gap-3 rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          <Avatar
                            name={member.user.fullName}
                            src={member.user.avatarUrl}
                            size="sm"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg">
                              {member.user.fullName}
                              {member.user.id === user?.id ? (
                                <span className="ml-1.5 text-xs font-normal text-fg-muted">
                                  (you)
                                </span>
                              ) : null}
                            </span>
                            <span className="block truncate text-xs text-fg-muted">
                              {member.user.email}
                            </span>
                          </span>
                        </button>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="brand">{roleLabel(member.role)}</Badge>
                          {member.isOwner ? <Badge tone="accent">Owner</Badge> : null}
                        </span>
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
                      <Td align="right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPanel({ kind: 'access', memberId: member.id })}
                        >
                          Manage
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableContainer>

            {membersQuery.data ? (
              <Pagination
                meta={membersQuery.data.meta}
                onPageChange={(page) => patchFilters({ page })}
                itemLabel="members"
              />
            ) : null}
          </DataState>
        </Card>
      ) : (
        <Card>
          <CardHeader
            as="h2"
            title="Roles"
            description="What each role in this workspace is allowed to do, grouped by the area it governs. Changing a role changes it for everyone who holds it; to change one person alone, use the permission overrides on their member panel."
          />
          <DataState
            isPending={rolesQuery.isPending}
            isError={rolesQuery.isError}
            error={rolesQuery.error}
            onRetry={() => void rolesQuery.refetch()}
            isEmpty={roles.length === 0}
            rows={3}
            columns={2}
            empty={
              <EmptyState
                icon={<ShieldCheck className="size-6" aria-hidden="true" />}
                title="No roles to show"
                description="Reading roles needs the roles:read permission, which your own role does not hold."
              />
            }
          >
            <CardBody className="flex flex-col gap-8">
              {roles.map((role) => (
                <section key={role.id} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-fg">{roleLabel(role)}</h3>
                    {role.isSystem ? <Badge tone="neutral">Built in</Badge> : null}
                    <Badge tone="info">{role.permissions.length} permissions</Badge>
                  </div>
                  {role.description ? (
                    <p className="text-sm leading-relaxed text-fg-muted">{role.description}</p>
                  ) : null}
                  <PermissionGroups permissions={role.permissions} />
                </section>
              ))}
            </CardBody>
          </DataState>
        </Card>
      )}

      {/* --- Invite ---------------------------------------------------------- */}
      <FormDrawer
        open={panel.kind === 'invite'}
        onClose={() => setPanel({ kind: 'none' })}
        title="Invite someone to this workspace"
        submitLabel="Send invitation"
        isSubmitting={invite.isPending}
        formError={formError}
        width="lg"
        onSubmit={inviteForm.handleSubmit((values) => {
          clearFormError();
          invite.mutate(values);
        })}
      >
        <p className="text-sm leading-relaxed text-fg-secondary">
          The invitation goes to the address, not to an account. If nobody has signed up with it, an
          account is created for them to finish; if somebody has, their existing account is attached
          and nothing on it is changed.
        </p>

        <Field label="Email address" required error={inviteForm.formState.errors.email?.message}>
          {(field) => (
            <Input {...field} {...inviteForm.register('email')} type="email" autoComplete="off" />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="First name"
            hint="Only used if the address has no account yet."
            error={inviteForm.formState.errors.firstName?.message}
          >
            {(field) => <Input {...field} {...inviteForm.register('firstName')} />}
          </Field>
          <Field label="Last name" error={inviteForm.formState.errors.lastName?.message}>
            {(field) => <Input {...field} {...inviteForm.register('lastName')} />}
          </Field>
        </div>

        {canReadRoles ? (
          <Field
            label="Role"
            required
            hint="This is the authority you are granting. Read what it allows before sending."
            error={inviteForm.formState.errors.roleId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...inviteForm.register('roleId')}
                placeholder="Choose a role"
                options={roles.map((role) => ({ value: role.id, label: roleLabel(role) }))}
              />
            )}
          </Field>
        ) : (
          <AreaUnavailable
            title="The list of roles is not part of your role"
            description="An invitation has to name the role the person will hold, and reading the workspace's roles needs the roles:read permission. Ask an owner to invite them, or to grant you that permission."
          />
        )}

        {inviteRole ? <RoleAuthority role={inviteRole} /> : null}
      </FormDrawer>

      {/* --- One member ------------------------------------------------------ */}
      <AccessDrawer
        member={panelMember}
        roles={roles}
        rolesReadable={canReadRoles}
        open={panel.kind === 'access' && panelMember !== null}
        onClose={() => setPanel({ kind: 'none' })}
        isSaving={update.isPending}
        onOpenOverrides={(member) => setPanel({ kind: 'overrides', memberId: member.id })}
        onSetStatus={(member, status) =>
          update.mutate({
            membershipId: member.id,
            status,
            message:
              status === 'ACTIVE'
                ? `${member.user.firstName} can sign in again`
                : `${member.user.firstName} is suspended`,
          })
        }
        onRequestRoleChange={(member, roleId, delta) => {
          // A change that touches nobody else's access is applied straight away;
          // one that hands over or takes away authority over colleagues goes
          // through a dialog that says which of the two it is.
          if (delta === 'none') {
            update.mutate({
              membershipId: member.id,
              roleId,
              message: `${member.user.firstName}'s role has changed`,
            });
            return;
          }
          setPanel({ kind: 'none' });
          setConfirmation({ kind: 'role', member, roleId, delta });
        }}
        onRequestRemoval={(member) => {
          setPanel({ kind: 'none' });
          setConfirmation({ kind: 'remove', member });
        }}
      />

      <OverrideEditor
        member={panelMember}
        catalogue={catalogue}
        open={panel.kind === 'overrides' && panelMember !== null}
        onClose={() => setPanel({ kind: 'none' })}
        canEdit={canManageRoles}
      />

      {/* --- Consequential changes ------------------------------------------- */}
      <ConfirmDialog
        open={confirmation !== null}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          if (confirmation.kind === 'remove') remove.mutate(confirmation.member);
          else
            update.mutate({
              membershipId: confirmation.member.id,
              roleId: confirmation.roleId,
              message: `${confirmation.member.user.firstName}'s role has changed`,
            });
        }}
        title={confirmationCopy?.title ?? ''}
        description={confirmationCopy?.description ?? ''}
        confirmLabel={confirmationCopy?.label ?? 'Confirm'}
        cancelLabel="Leave it as it is"
        destructive={confirmationCopy?.destructive ?? false}
        loading={update.isPending || remove.isPending}
      />
    </>
  );
}
