import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Pencil, Plus, Sparkles, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  ActiveBadge,
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  WeeklyWindowEditor,
  clockToMinutes,
  filterOptions,
  minutesToClock,
  newWindowKey,
  ownerKeys,
  toSearchParams,
  useLocationsLookup,
  useServicesLookup,
  type StaffAvailabilityRule,
  type StaffServiceLink,
  type WeeklyWindow,
} from '@/components/owner';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
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
  Textarea,
  Th,
  Tr,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { PERMISSIONS } from '@/lib/permissions';
import { timezoneOptions } from '@/lib/timezones';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { StaffProfile, WorkspaceMember } from '@/types/api';
import { StaffLeavePanel } from './StaffLeavePanel';

const PAGE_SIZE = 20;
const TIMEZONE_OPTIONS = timezoneOptions();

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value));

const inheritableNumber = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (Number.isInteger(value) && value >= min && value <= max),
      message,
    );

const staffSchema = z.object({
  membershipId: z.string(),
  displayName: z.string().trim().min(1, 'A display name is required.').max(160),
  title: optionalText,
  bio: optionalText,
  timezone: z.string().min(1, 'Choose the timezone this person works in.'),
  // Omitted rather than nulled when blank: `staff_profiles.color` is NOT NULL
  // with a database default, so the server accepts the key being absent but
  // rejects an explicit null. `undefined` is dropped by JSON.stringify, which
  // is exactly the "leave it to the default" the blank field means.
  color: z
    .string()
    .trim()
    .transform((value) => (value === '' ? undefined : value))
    .refine(
      (value) => value === undefined || /^#[0-9A-Fa-f]{6}$/.test(value),
      'Use a six-digit hex colour such as #4F46E5.',
    ),
  defaultLocationId: z.string().transform((value) => (value === '' ? null : value)),
  preBufferMinutes: inheritableNumber(0, 1440, 'Use 0–1440 minutes, or leave blank to inherit.'),
  postBufferMinutes: inheritableNumber(0, 1440, 'Use 0–1440 minutes, or leave blank to inherit.'),
  minNoticeMinutes: inheritableNumber(0, 525_600, 'Use minutes, or leave blank to inherit.'),
  maxDailyAppointments: inheritableNumber(1, 1000, 'Use 1–1000, or leave blank for no cap.'),
  maxWeeklyAppointments: inheritableNumber(1, 1000, 'Use 1–1000, or leave blank for no cap.'),
  assignmentWeight: z.coerce
    .number()
    .int()
    .min(1, 'Weight is between 1 and 100.')
    .max(100, 'Weight is between 1 and 100.'),
  isBookable: z.boolean(),
  isActive: z.boolean(),
});

type StaffFormValues = z.input<typeof staffSchema>;

const EMPTY_FORM: StaffFormValues = {
  membershipId: '',
  displayName: '',
  title: '',
  bio: '',
  timezone: '',
  color: '',
  defaultLocationId: '',
  preBufferMinutes: '',
  postBufferMinutes: '',
  minNoticeMinutes: '',
  maxDailyAppointments: '',
  maxWeeklyAppointments: '',
  assignmentWeight: 1,
  isBookable: true,
  isActive: true,
};

const FORM_FIELDS = [
  'membershipId',
  'displayName',
  'title',
  'bio',
  'timezone',
  'color',
  'defaultLocationId',
  'preBufferMinutes',
  'postBufferMinutes',
  'minNoticeMinutes',
  'maxDailyAppointments',
  'maxWeeklyAppointments',
  'assignmentWeight',
  'isBookable',
  'isActive',
] as const;

function inheritedValue(value: number | null): string {
  return value === null ? '' : String(value);
}

// ---------------------------------------------------------------------------
// Services this person delivers
// ---------------------------------------------------------------------------

function ServicesDrawer({
  profile,
  open,
  onClose,
}: {
  profile: StaffProfile | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const services = useServicesLookup();
  const [selected, setSelected] = useState<string[]>([]);

  const canManage = can(PERMISSIONS.STAFF_MANAGE);

  const linksQuery = useQuery({
    queryKey: ownerKeys.staffServices(activeBusinessId, profile?.id ?? ''),
    queryFn: () => api.get<StaffServiceLink[]>(`/staff/${profile?.id ?? ''}/services`),
    enabled: open && profile !== null,
  });

  useEffect(() => {
    if (!linksQuery.data) return;
    setSelected(linksQuery.data.map((link) => link.serviceId));
  }, [linksQuery.data]);

  const save = useMutation<unknown, unknown, void>({
    mutationFn: () => api.put(`/staff/${profile?.id ?? ''}/services`, { serviceIds: selected }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'staff'],
      });
      toast({ tone: 'success', title: 'Services updated' });
      onClose();
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not save these services',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={profile ? `${profile.displayName} — services` : 'Services'}
      description="Only the services ticked here are ever offered with this provider."
      footer={
        canManage ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save services
            </Button>
          </>
        ) : undefined
      }
    >
      {linksQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : linksQuery.isError ? (
        <ErrorState error={linksQuery.error} onRetry={() => void linksQuery.refetch()} />
      ) : services.items.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-6" aria-hidden="true" />}
          title="No services to assign yet"
          description="Add a service to the catalogue first, then come back and say who delivers it."
        />
      ) : (
        <fieldset className="flex flex-col gap-3" disabled={!canManage}>
          <legend className="mf-sr-only">Services this provider delivers</legend>
          {services.items.map((service) => (
            <Checkbox
              key={service.id}
              label={service.name}
              description={service.isActive ? undefined : 'Inactive service'}
              checked={selected.includes(service.id)}
              onChange={() =>
                setSelected((current) =>
                  current.includes(service.id)
                    ? current.filter((id) => id !== service.id)
                    : [...current, service.id],
                )
              }
            />
          ))}
        </fieldset>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Working hours and leave
// ---------------------------------------------------------------------------

function AvailabilityDrawer({
  profile,
  open,
  onClose,
}: {
  profile: StaffProfile | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();
  const [windows, setWindows] = useState<WeeklyWindow[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.AVAILABILITY_MANAGE);
  const staffProfileId = profile?.id ?? '';

  const rulesQuery = useQuery({
    queryKey: ownerKeys.staffRules(activeBusinessId, staffProfileId),
    queryFn: () =>
      api.getPage<StaffAvailabilityRule>(
        `/availability/staff/${staffProfileId}/rules${toSearchParams({ pageSize: 100 })}`,
      ),
    enabled: open && profile !== null,
  });

  useEffect(() => {
    if (!rulesQuery.data) return;
    setWindows(
      rulesQuery.data.items.map((rule) => ({
        key: newWindowKey(),
        dayOfWeek: rule.dayOfWeek,
        startTime: minutesToClock(rule.startMinute),
        endTime: minutesToClock(rule.endMinute),
        isActive: rule.isActive,
        locationId: rule.locationId,
      })),
    );
  }, [rulesQuery.data]);

  const save = useMutation<unknown, unknown, void>({
    mutationFn: () =>
      api.put(`/availability/staff/${staffProfileId}/rules`, {
        rules: windows.map((window) => ({
          dayOfWeek: window.dayOfWeek,
          startTime: window.startTime,
          endTime: window.endTime,
          locationId: window.locationId,
          isActive: window.isActive,
        })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ownerKeys.staffRules(activeBusinessId, staffProfileId),
      });
      setSaveError(null);
      toast({ tone: 'success', title: 'Working hours saved' });
    },
    onError: (error) => {
      // The API rejects overlapping windows with a message naming both, which
      // is far more useful than a toast that disappears.
      setSaveError(
        isApiError(error)
          ? (error.details[0]?.message ?? error.message)
          : 'Could not save these working hours.',
      );
    },
  });

  const totalWeeklyMinutes = windows
    .filter((window) => window.isActive)
    .reduce((total, window) => {
      const start = clockToMinutes(window.startTime);
      const end = clockToMinutes(window.endTime);
      return total + (end > start ? end - start : end + 1440 - start);
    }, 0);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={profile ? `${profile.displayName} — availability` : 'Availability'}
      description={
        profile
          ? `Times are wall-clock in ${profile.timezone}, the zone this person works in.`
          : undefined
      }
      width="lg"
      footer={
        canManage ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Close
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save working hours
            </Button>
          </>
        ) : undefined
      }
    >
      {rulesQuery.isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : rulesQuery.isError ? (
        <ErrorState error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">Recurring weekly hours</h3>
              <p className="text-xs tabular-nums text-fg-muted">
                {(totalWeeklyMinutes / 60).toFixed(1)} hours a week
              </p>
            </div>

            {saveError ? (
              <p
                role="alert"
                className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
              >
                {saveError}
              </p>
            ) : null}

            <WeeklyWindowEditor
              windows={windows}
              onChange={setWindows}
              disabled={!canManage}
              locationOptions={filterOptions(locations.items, 'Any location', (location) => ({
                value: location.id,
                label: location.name,
              }))}
            />
          </section>

          {profile ? (
            <StaffLeavePanel staffProfileId={profile.id} timezone={profile.timezone} />
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function StaffPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();

  const [page, setPage] = useState(1);
  const [bookableFilter, setBookableFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffProfile | null>(null);
  const [deleting, setDeleting] = useState<StaffProfile | null>(null);
  const [assigning, setAssigning] = useState<StaffProfile | null>(null);
  const [scheduling, setScheduling] = useState<StaffProfile | null>(null);

  const canManage = can(PERMISSIONS.STAFF_MANAGE);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    isBookable: bookableFilter === '' ? undefined : bookableFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.staff(activeBusinessId, scope),
    queryFn: () => api.getPage<StaffProfile>(`/staff${toSearchParams(scope)}`),
  });

  // A staff profile is created against an existing membership: the API reads
  // the user from that row, so there is no way to name a person directly.
  const membersQuery = useQuery({
    queryKey: ownerKeys.members(activeBusinessId),
    queryFn: () => api.get<WorkspaceMember[]>('/workspace/members'),
    enabled: canManage && can(PERMISSIONS.MEMBERS_READ),
  });

  const unprofiledMembers = (membersQuery.data ?? []).filter(
    (member) => member.staffProfile === null && member.status === 'ACTIVE',
  );

  const form = useForm<StaffFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(staffSchema, undefined, { raw: true }),
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
            membershipId: editing.membershipId ?? '',
            displayName: editing.displayName,
            title: editing.title ?? '',
            bio: editing.bio ?? '',
            timezone: editing.timezone,
            color: editing.color ?? '',
            defaultLocationId: editing.defaultLocationId ?? '',
            preBufferMinutes: inheritedValue(editing.preBufferMinutes),
            postBufferMinutes: inheritedValue(editing.postBufferMinutes),
            minNoticeMinutes: inheritedValue(editing.minNoticeMinutes),
            maxDailyAppointments: inheritedValue(editing.maxDailyAppointments),
            maxWeeklyAppointments: inheritedValue(editing.maxWeeklyAppointments),
            assignmentWeight: editing.assignmentWeight,
            isBookable: editing.isBookable,
            isActive: editing.isActive,
          }
        : { ...EMPTY_FORM, timezone: activeTimezone },
    );
  }, [drawerOpen, editing, form, clearFormError, activeTimezone]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'staff'],
    });
    void queryClient.invalidateQueries({ queryKey: ownerKeys.members(activeBusinessId) });
  };

  const save = useMutation<StaffProfile, unknown, z.output<typeof staffSchema>>({
    mutationFn: ({ membershipId, ...rest }) =>
      editing
        ? // membershipId is absent from the update schema on purpose: rebinding a
          // profile to another person would silently reassign their history.
          api.patch<StaffProfile>(`/staff/${editing.id}`, rest)
        : api.post<StaffProfile>('/staff', { membershipId, ...rest }),
    onSuccess: () => {
      invalidate();
      toast({
        tone: 'success',
        title: editing ? 'Staff profile updated' : 'Staff profile created',
      });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/staff/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Staff profile removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this profile',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Staff"
        description="The people who deliver your services, the hours they work and the services they are offered for."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              disabled={unprofiledMembers.length === 0}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add staff profile
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <FilterField label="Bookable">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={bookableFilter}
                onChange={(event) => {
                  setBookableFilter(event.target.value);
                  setPage(1);
                }}
                options={[
                  { value: '', label: 'Everyone' },
                  { value: 'true', label: 'Bookable only' },
                  { value: 'false', label: 'Not bookable' },
                ]}
              />
            )}
          </FilterField>
        </FilterBar>
        {/*
         * A profile can only be created against an existing membership, so the
         * button is disabled whenever there is nobody left to attach one to —
         * and the reason is spelled out, because a dead button with no
         * explanation is worse than no button.
         */}
        {canManage && unprofiledMembers.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {membersQuery.isSuccess
              ? 'Every active member of this workspace already has a staff profile. Someone has to join the workspace before another can be created.'
              : 'A staff profile is created against an existing workspace member, and your role cannot read the member list — so one cannot be added from here.'}
          </p>
        ) : null}
      </PageHeader>

      <Card>
        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          columns={5}
          empty={
            <EmptyState
              icon={<Users className="size-6" aria-hidden="true" />}
              title={bookableFilter === '' ? 'No staff profiles yet' : 'Nobody matches that filter'}
              description={
                bookableFilter === ''
                  ? 'A staff profile is what makes a member of your workspace bookable. Create one for each person who delivers a service.'
                  : 'Clear the filter to see everyone.'
              }
              action={
                bookableFilter !== '' ? (
                  <Button variant="secondary" onClick={() => setBookableFilter('')}>
                    Clear filter
                  </Button>
                ) : canManage && unprofiledMembers.length > 0 ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add staff profile
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Staff profiles">
              <THead>
                <Tr>
                  <Th>Person</Th>
                  <Th>Default location</Th>
                  <Th>Timezone</Th>
                  <Th>Status</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((profile) => (
                  <Tr key={profile.id}>
                    <Td>
                      <span className="flex items-center gap-3">
                        <Avatar
                          name={profile.displayName}
                          src={profile.avatarUrl}
                          color={profile.color}
                          size="sm"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-fg">
                            {profile.displayName}
                          </span>
                          {profile.title ? (
                            <span className="block truncate text-xs text-fg-muted">
                              {profile.title}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {locations.items.find(
                          (location) => location.id === profile.defaultLocationId,
                        )?.name ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">{profile.timezone}</span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ActiveBadge active={profile.isActive} />
                        {!profile.isBookable ? <Badge tone="neutral">Not bookable</Badge> : null}
                      </div>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Working hours for ${profile.displayName}`}
                          onClick={() => setScheduling(profile)}
                        >
                          <CalendarRange className="size-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Services for ${profile.displayName}`}
                          onClick={() => setAssigning(profile)}
                        >
                          <Sparkles className="size-4" aria-hidden="true" />
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Edit ${profile.displayName}`}
                              onClick={() => setEditing(profile)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-danger-text"
                              aria-label={`Remove ${profile.displayName}`}
                              onClick={() => setDeleting(profile)}
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
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="staff" />
          ) : null}
        </DataState>
      </Card>

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.displayName}` : 'Add a staff profile'}
        description={
          editing ? undefined : 'A profile is created against an existing member of this workspace.'
        }
        submitLabel={editing ? 'Save changes' : 'Create profile'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(staffSchema.parse(values));
        })}
      >
        {!editing ? (
          <Field
            label="Workspace member"
            required
            hint="Only members without a staff profile are listed."
            error={form.formState.errors.membershipId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('membershipId')}
                placeholder="Choose a member"
                options={unprofiledMembers.map((member) => ({
                  value: member.id,
                  label: `${member.user.firstName} ${member.user.lastName} — ${member.role.name}`,
                }))}
              />
            )}
          </Field>
        ) : null}

        <Field
          label="Display name"
          required
          hint="What customers see. Defaults to the member's own name."
          error={form.formState.errors.displayName?.message}
        >
          {(field) => <Input {...field} {...form.register('displayName')} autoComplete="off" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" error={form.formState.errors.title?.message}>
            {(field) => (
              <Input {...field} {...form.register('title')} placeholder="Lead Massage Therapist" />
            )}
          </Field>
          <Field
            label="Colour"
            hint="Used on the calendar."
            error={form.formState.errors.color?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('color')} placeholder="#0F766E" maxLength={7} />
            )}
          </Field>
        </div>

        <Field label="Bio" error={form.formState.errors.bio?.message}>
          {(field) => <Textarea {...field} {...form.register('bio')} rows={3} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Timezone"
            required
            hint="Working hours and leave are authored in this zone."
            error={form.formState.errors.timezone?.message}
          >
            {(field) => (
              <Select {...field} {...form.register('timezone')} options={TIMEZONE_OPTIONS} />
            )}
          </Field>
          <Field label="Default location" error={form.formState.errors.defaultLocationId?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('defaultLocationId')}
                options={filterOptions(locations.items, 'No default', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </Field>
        </div>

        <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">Load and buffers</legend>
          <Field
            label="Buffer before"
            hint="Minutes. Blank inherits the service or workspace default."
            error={form.formState.errors.preBufferMinutes?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('preBufferMinutes')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Buffer after"
            hint="Minutes. Blank inherits."
            error={form.formState.errors.postBufferMinutes?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('postBufferMinutes')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Minimum notice"
            hint="Minutes. Blank inherits."
            error={form.formState.errors.minNoticeMinutes?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('minNoticeMinutes')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Assignment weight"
            hint="Higher takes a larger share of round-robin bookings."
            error={form.formState.errors.assignmentWeight?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('assignmentWeight')}
                type="number"
                min={1}
                max={100}
              />
            )}
          </Field>
          <Field
            label="Max appointments a day"
            hint="Blank means no cap."
            error={form.formState.errors.maxDailyAppointments?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('maxDailyAppointments')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Max appointments a week"
            hint="Blank means no cap."
            error={form.formState.errors.maxWeeklyAppointments?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('maxWeeklyAppointments')} inputMode="numeric" />
            )}
          </Field>
        </fieldset>

        <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <Switch
            checked={form.watch('isBookable')}
            onCheckedChange={(checked) =>
              form.setValue('isBookable', checked, { shouldDirty: true })
            }
            label="Bookable"
            description="Turn off for someone who runs the diary but does not take appointments."
          />
          <Switch
            checked={form.watch('isActive')}
            onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
            label="Active"
            description="An inactive profile keeps its history but is offered to nobody."
          />
        </div>
      </FormDrawer>

      <ServicesDrawer
        profile={assigning}
        open={assigning !== null}
        onClose={() => setAssigning(null)}
      />

      <AvailabilityDrawer
        profile={scheduling}
        open={scheduling !== null}
        onClose={() => setScheduling(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.displayName}'s profile?` : ''}
        description="Their past appointments keep their record, but they stop being offered for anything and their working hours no longer apply."
        confirmLabel="Remove profile"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
