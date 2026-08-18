import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UserPlus, UsersRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  ActiveBadge,
  DataState,
  FormDrawer,
  SearchField,
  ownerKeys,
  toSearchParams,
  useDebouncedValue,
  useStaffLookup,
  type TeamDetail,
} from '@/components/owner';
import {
  Avatar,
  Button,
  Card,
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
  Td,
  Th,
  Tr,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { AssignmentStrategy, Team } from '@/types/api';

const PAGE_SIZE = 20;

/**
 * How a team picks who takes the next booking.
 *
 * The wording matters more than the enum: an owner choosing between these is
 * deciding how their staff's day fills up, and "POOLED" tells them nothing.
 */
const STRATEGIES: Array<{ value: AssignmentStrategy; label: string; hint: string }> = [
  {
    value: 'ROUND_ROBIN',
    label: 'Round robin',
    hint: 'Takes turns, weighted — the member who went longest without a booking is next.',
  },
  {
    value: 'POOLED',
    label: 'Pooled',
    hint: 'Anyone free may take it; the first available slot wins.',
  },
  {
    value: 'SMART_MATCH',
    label: 'Smart match',
    hint: "Scores each member on fit, load and the customer's history.",
  },
  {
    value: 'LEAST_BUSY',
    label: 'Least busy',
    hint: 'Goes to whoever has the lightest day.',
  },
  {
    value: 'MANUAL',
    label: 'Manual',
    hint: 'Nobody is assigned automatically; the front desk chooses.',
  },
];

const teamSchema = z.object({
  name: z.string().trim().min(1, 'A team name is required.').max(120),
  description: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => (value === '' ? null : value)),
  assignmentStrategy: z.enum(['ROUND_ROBIN', 'POOLED', 'SMART_MATCH', 'LEAST_BUSY', 'MANUAL']),
  isActive: z.boolean(),
});

type TeamFormValues = z.input<typeof teamSchema>;
type TeamPayload = z.output<typeof teamSchema>;

const EMPTY_FORM: TeamFormValues = {
  name: '',
  description: '',
  assignmentStrategy: 'ROUND_ROBIN',
  isActive: true,
};

const FORM_FIELDS = ['name', 'description', 'assignmentStrategy', 'isActive'] as const;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MembersDrawer({
  teamId,
  open,
  onClose,
}: {
  teamId: string | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const staff = useStaffLookup();
  const [adding, setAdding] = useState('');

  const canManage = can(PERMISSIONS.TEAMS_MANAGE);

  const teamQuery = useQuery({
    queryKey: ownerKeys.team(activeBusinessId, teamId ?? ''),
    queryFn: () => api.get<TeamDetail>(`/teams/${teamId ?? ''}`),
    enabled: open && teamId !== null,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'teams'],
    });
  };

  const reportError = (error: unknown, title: string): void => {
    toast({
      tone: 'error',
      title,
      description: isApiError(error) ? error.message : undefined,
    });
  };

  const addMember = useMutation<unknown, unknown, string>({
    mutationFn: (staffProfileId) => api.post(`/teams/${teamId ?? ''}/members`, { staffProfileId }),
    onSuccess: () => {
      invalidate();
      setAdding('');
      toast({ tone: 'success', title: 'Added to the team' });
    },
    onError: (error) => reportError(error, 'Could not add that person'),
  });

  const updateMember = useMutation<
    unknown,
    unknown,
    { memberId: string; patch: { weight?: number; priority?: number; isActive?: boolean } }
  >({
    mutationFn: ({ memberId, patch }) =>
      api.patch(`/teams/${teamId ?? ''}/members/${memberId}`, patch),
    onSuccess: invalidate,
    onError: (error) => reportError(error, 'Could not update that member'),
  });

  const removeMember = useMutation<unknown, unknown, string>({
    mutationFn: (memberId) => api.delete(`/teams/${teamId ?? ''}/members/${memberId}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Removed from the team' });
    },
    onError: (error) => reportError(error, 'Could not remove that member'),
  });

  const team = teamQuery.data;
  const memberIds = new Set((team?.members ?? []).map((member) => member.staffProfileId));
  const addable = staff.items.filter((profile) => !memberIds.has(profile.id));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={team ? `${team.name} — members` : 'Team members'}
      description={
        team ? STRATEGIES.find((entry) => entry.value === team.assignmentStrategy)?.hint : undefined
      }
      width="lg"
    >
      {teamQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : teamQuery.isError ? (
        <ErrorState error={teamQuery.error} onRetry={() => void teamQuery.refetch()} />
      ) : team ? (
        <div className="flex flex-col gap-5">
          {canManage ? (
            <div className="flex items-end gap-2">
              <Field label="Add a staff member" className="flex-1">
                {(field) => (
                  <Select
                    {...field}
                    value={adding}
                    onChange={(event) => setAdding(event.target.value)}
                    placeholder={addable.length === 0 ? 'Everyone is already here' : undefined}
                    disabled={addable.length === 0}
                    options={addable.map((profile) => ({
                      value: profile.id,
                      label: profile.displayName,
                    }))}
                  />
                )}
              </Field>
              <Button
                onClick={() => addMember.mutate(adding)}
                disabled={adding === ''}
                loading={addMember.isPending}
                leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
              >
                Add
              </Button>
            </div>
          ) : null}

          {team.members.length === 0 ? (
            <EmptyState
              icon={<UsersRound className="size-6" aria-hidden="true" />}
              title="Nobody is on this team yet"
              description="A team with no members is never assigned a booking. Add the people who deliver its services."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {team.members.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
                >
                  <Avatar
                    name={member.staffProfile.displayName}
                    src={member.staffProfile.avatarUrl}
                    color={member.staffProfile.color}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {member.staffProfile.displayName}
                    </p>
                    {member.staffProfile.title ? (
                      <p className="truncate text-xs text-fg-muted">{member.staffProfile.title}</p>
                    ) : null}
                  </div>

                  {canManage ? (
                    <>
                      <Field label="Weight" className="w-20">
                        {(field) => (
                          <Input
                            {...field}
                            inputSize="sm"
                            type="number"
                            min={1}
                            max={100}
                            defaultValue={member.weight}
                            onBlur={(event) => {
                              const weight = Number(event.target.value);
                              if (Number.isInteger(weight) && weight !== member.weight) {
                                updateMember.mutate({
                                  memberId: member.id,
                                  patch: { weight },
                                });
                              }
                            }}
                          />
                        )}
                      </Field>
                      <Field label="Priority" className="w-20">
                        {(field) => (
                          <Input
                            {...field}
                            inputSize="sm"
                            type="number"
                            min={0}
                            max={1000}
                            defaultValue={member.priority}
                            onBlur={(event) => {
                              const priority = Number(event.target.value);
                              if (Number.isInteger(priority) && priority !== member.priority) {
                                updateMember.mutate({
                                  memberId: member.id,
                                  patch: { priority },
                                });
                              }
                            }}
                          />
                        )}
                      </Field>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-danger-text"
                        aria-label={`Remove ${member.staffProfile.displayName} from ${team.name}`}
                        onClick={() => removeMember.mutate(member.id)}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-fg-muted">
                      weight {member.weight} · priority {member.priority}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs leading-relaxed text-fg-muted">
            Weight decides how often round robin lands on someone — a weight of 2 takes twice as
            many bookings as a weight of 1. Priority breaks ties, and a lower number wins.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TeamsPage(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [managing, setManaging] = useState<Team | null>(null);

  const canManage = can(PERMISSIONS.TEAMS_MANAGE);
  const debouncedSearch = useDebouncedValue(search);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch === '' ? undefined : debouncedSearch,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.teams(activeBusinessId, scope),
    queryFn: () => api.getPage<Team>(`/teams${toSearchParams(scope)}`),
  });

  const form = useForm<TeamFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(teamSchema, undefined, { raw: true }),
    defaultValues: EMPTY_FORM,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(form.setError, FORM_FIELDS);

  const drawerOpen = creating || editing !== null;

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    form.reset(
      editing
        ? {
            name: editing.name,
            description: editing.description ?? '',
            assignmentStrategy: editing.assignmentStrategy,
            isActive: editing.isActive,
          }
        : EMPTY_FORM,
    );
  }, [drawerOpen, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'teams'],
    });
  };

  const save = useMutation<Team, unknown, TeamPayload>({
    mutationFn: (payload) =>
      editing
        ? api.patch<Team>(`/teams/${editing.id}`, payload)
        : api.post<Team>('/teams', payload),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Team updated' : 'Team created' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/teams/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Team removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this team',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const selectedStrategy = form.watch('assignmentStrategy');

  return (
    <>
      <PageHeader
        title="Teams"
        description="Groups of staff who share work. A booking link pointed at a team lets the assignment strategy choose who takes each booking."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Create team
            </Button>
          ) : null
        }
      >
        <SearchField
          label="Search teams"
          value={search}
          placeholder="Therapy, movement…"
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
      </PageHeader>

      <Card>
        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          columns={4}
          empty={
            <EmptyState
              icon={<UsersRound className="size-6" aria-hidden="true" />}
              title={search === '' ? 'No teams yet' : 'No team matches that search'}
              description={
                search === ''
                  ? 'Create a team when several people deliver the same service and you want bookings shared between them automatically.'
                  : 'Try a different name, or clear the search.'
              }
              action={
                search !== '' ? (
                  <Button variant="secondary" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : canManage ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Create team
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Teams in this workspace">
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Assignment</Th>
                  <Th>Status</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((team) => (
                  <Tr key={team.id}>
                    <Td>
                      <span className="font-medium text-fg">{team.name}</span>
                      {team.description ? (
                        <span className="block max-w-md truncate text-xs text-fg-muted">
                          {team.description}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {STRATEGIES.find((entry) => entry.value === team.assignmentStrategy)
                          ?.label ?? humanizeEnum(team.assignmentStrategy)}
                      </span>
                    </Td>
                    <Td>
                      <ActiveBadge active={team.isActive} />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setManaging(team)}>
                          Members
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Edit ${team.name}`}
                              onClick={() => setEditing(team)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-danger-text"
                              aria-label={`Remove ${team.name}`}
                              onClick={() => setDeleting(team)}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="teams" />
          ) : null}
        </DataState>
      </Card>

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Create a team'}
        submitLabel={editing ? 'Save changes' : 'Create team'}
        isSubmitting={save.isPending}
        formError={formError}
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(teamSchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>

        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => <Textarea {...field} {...form.register('description')} rows={2} />}
        </Field>

        <Field
          label="Assignment strategy"
          required
          hint={STRATEGIES.find((entry) => entry.value === selectedStrategy)?.hint}
          error={form.formState.errors.assignmentStrategy?.message}
        >
          {(field) => (
            <Select
              {...field}
              {...form.register('assignmentStrategy')}
              options={STRATEGIES.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          )}
        </Field>

        <Switch
          checked={form.watch('isActive')}
          onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
          label="Active"
          description="An inactive team is never assigned new bookings."
        />
      </FormDrawer>

      <MembersDrawer
        teamId={managing?.id ?? null}
        open={managing !== null}
        onClose={() => setManaging(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="Booking links pointed at this team will stop working until you point them elsewhere. Existing appointments are unaffected."
        confirmLabel="Remove team"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
