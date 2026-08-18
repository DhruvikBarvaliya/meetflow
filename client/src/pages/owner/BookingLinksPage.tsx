import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Link2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  ActiveBadge,
  CopyableUrl,
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  SearchField,
  filterOptions,
  ownerKeys,
  toSearchParams,
  useDebouncedValue,
  useLocationsLookup,
  useServicesLookup,
  useStaffLookup,
  useTeamsLookup,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Pagination,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { formatDate, formatNumber } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { BookingLink, BookingLinkType, CustomQuestion } from '@/types/api';

const PAGE_SIZE = 20;

const LINK_TYPES: Array<{ value: BookingLinkType; label: string; hint: string }> = [
  {
    value: 'CATALOG',
    label: 'Catalogue',
    hint: 'Customers browse several services and pick one.',
  },
  {
    value: 'SINGLE_SERVICE',
    label: 'One service',
    hint: 'Straight to booking a single service.',
  },
  { value: 'TEAM', label: 'Team', hint: 'Books a team; the strategy chooses who takes it.' },
  { value: 'STAFF', label: 'One person', hint: "Books one provider's own diary." },
];

/** Mirrors `CUSTOM_QUESTION_TYPES` in the booking-links validation schema. */
const QUESTION_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'URL',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
] as const;

type QuestionType = (typeof QUESTION_TYPES)[number];

/** Only these two draw their answer from a fixed list. */
const CHOICE_TYPES: readonly QuestionType[] = ['SELECT', 'MULTI_SELECT'];

interface QuestionDraft {
  id: string;
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** Comma separated in the editor; split on the way out. */
  options: string;
}

let questionSequence = 0;

function toDraft(question: CustomQuestion): QuestionDraft {
  questionSequence += 1;
  return {
    id: `question-${questionSequence}`,
    key: question.key,
    label: question.label,
    type: question.type as QuestionType,
    required: question.required,
    options: (question.options ?? []).join(', '),
  };
}

const linkSchema = z.object({
  name: z.string().trim().min(1, 'A booking link needs a name.').max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value === '' ? undefined : value))
    .refine(
      (value) => value === undefined || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
      'Use lowercase letters, numbers and single hyphens.',
    ),
  description: z
    .string()
    .trim()
    .max(4000)
    .transform((value) => (value === '' ? null : value)),
  type: z.enum(['CATALOG', 'SINGLE_SERVICE', 'TEAM', 'STAFF']),
  serviceId: z.string(),
  teamId: z.string(),
  staffProfileId: z.string(),
  locationId: z.string(),
  allowStaffSelection: z.boolean(),
  requiresApproval: z.boolean(),
  maxBookingsTotal: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (Number.isInteger(value) && value > 0),
      'Use a whole number above zero, or leave blank for no cap.',
    ),
  isActive: z.boolean(),
});

type LinkFormValues = z.input<typeof linkSchema>;

const EMPTY_FORM: LinkFormValues = {
  name: '',
  slug: '',
  description: '',
  type: 'CATALOG',
  serviceId: '',
  teamId: '',
  staffProfileId: '',
  locationId: '',
  allowStaffSelection: true,
  requiresApproval: false,
  maxBookingsTotal: '',
  isActive: true,
};

const FORM_FIELDS = [
  'name',
  'slug',
  'description',
  'type',
  'serviceId',
  'teamId',
  'staffProfileId',
  'locationId',
  'allowStaffSelection',
  'requiresApproval',
  'maxBookingsTotal',
  'isActive',
] as const;

/**
 * The target column each link type must fill, mirroring `booking_links_target_check`.
 *
 * A link carrying the wrong one is a 422, and the wrong one left behind after a
 * type change is the easy way to produce it — so the payload is assembled from
 * this map rather than by spreading whatever the form happens to hold.
 */
const TARGET_FIELD: Record<BookingLinkType, 'serviceId' | 'teamId' | 'staffProfileId' | null> = {
  CATALOG: null,
  SINGLE_SERVICE: 'serviceId',
  TEAM: 'teamId',
  STAFF: 'staffProfileId',
};

export default function BookingLinksPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const services = useServicesLookup();
  const teams = useTeamsLookup();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BookingLink | null>(null);
  const [deleting, setDeleting] = useState<BookingLink | null>(null);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [catalogServiceIds, setCatalogServiceIds] = useState<string[]>([]);

  const canManage = can(PERMISSIONS.BOOKING_LINKS_MANAGE);
  const debouncedSearch = useDebouncedValue(search);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch === '' ? undefined : debouncedSearch,
    type: typeFilter === '' ? undefined : typeFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.bookingLinks(activeBusinessId, scope),
    queryFn: () => api.getPage<BookingLink>(`/booking-links${toSearchParams(scope)}`),
  });

  const form = useForm<LinkFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(linkSchema, undefined, { raw: true }),
    defaultValues: EMPTY_FORM,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(form.setError, FORM_FIELDS);

  const drawerOpen = creating || editing !== null;
  const selectedType = form.watch('type') as BookingLinkType;

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    setQuestions(editing ? editing.customQuestions.map(toDraft) : []);
    setCatalogServiceIds([]);
    form.reset(
      editing
        ? {
            name: editing.name,
            slug: editing.slug,
            description: editing.description ?? '',
            type: editing.type,
            serviceId: editing.serviceId ?? '',
            teamId: editing.teamId ?? '',
            staffProfileId: editing.staffProfileId ?? '',
            locationId: editing.locationId ?? '',
            allowStaffSelection: editing.allowStaffSelection,
            requiresApproval: editing.requiresApproval,
            maxBookingsTotal:
              editing.maxBookingsTotal === null ? '' : String(editing.maxBookingsTotal),
            isActive: editing.isActive,
          }
        : EMPTY_FORM,
    );
  }, [drawerOpen, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'booking-links'],
    });
  };

  const questionsPayload = (): CustomQuestion[] =>
    questions.map((question) => ({
      key: question.key,
      label: question.label,
      type: question.type as CustomQuestion['type'],
      required: question.required,
      options: CHOICE_TYPES.includes(question.type)
        ? question.options
            .split(',')
            .map((option) => option.trim())
            .filter((option) => option !== '')
        : [],
    }));

  const save = useMutation<BookingLink, unknown, z.output<typeof linkSchema>>({
    mutationFn: (values) => {
      const target = TARGET_FIELD[values.type];
      const targetValue =
        target === 'serviceId'
          ? values.serviceId
          : target === 'teamId'
            ? values.teamId
            : target === 'staffProfileId'
              ? values.staffProfileId
              : '';

      const base = {
        name: values.name,
        description: values.description,
        type: values.type,
        // Every target the type does not use must be absent, not empty.
        serviceId: target === 'serviceId' ? targetValue : null,
        teamId: target === 'teamId' ? targetValue : null,
        staffProfileId: target === 'staffProfileId' ? targetValue : null,
        locationId: values.locationId === '' ? null : values.locationId,
        allowStaffSelection: values.allowStaffSelection,
        requiresApproval: values.requiresApproval,
        customQuestions: questionsPayload(),
        maxBookingsTotal: values.maxBookingsTotal,
        isActive: values.isActive,
      };

      if (editing) return api.patch<BookingLink>(`/booking-links/${editing.id}`, base);

      return api.post<BookingLink>('/booking-links', {
        ...base,
        ...(values.slug === undefined ? {} : { slug: values.slug }),
        // Only a catalogue link carries a list of offered services; the API
        // rejects one on any other type.
        ...(values.type === 'CATALOG' && catalogServiceIds.length > 0
          ? { serviceIds: catalogServiceIds }
          : {}),
      });
    },
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Booking link updated' : 'Booking link created' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/booking-links/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Booking link removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this link',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters = search !== '' || typeFilter !== '';

  const addQuestion = (): void => {
    questionSequence += 1;
    setQuestions((current) => [
      ...current,
      {
        id: `question-${questionSequence}`,
        key: '',
        label: '',
        type: 'TEXT',
        required: false,
        options: '',
      },
    ]);
  };

  return (
    <>
      <PageHeader
        title="Booking links"
        description="The addresses you share with customers. Each one decides what can be booked through it, and what you ask for on the way."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Create link
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={search}
            placeholder="Name or slug"
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <FilterField label="Type">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(event.target.value);
                  setPage(1);
                }}
                options={[
                  { value: '', label: 'Every type' },
                  ...LINK_TYPES.map((entry) => ({ value: entry.value, label: entry.label })),
                ]}
              />
            )}
          </FilterField>
        </FilterBar>
      </PageHeader>

      <DataState
        isPending={listQuery.isPending}
        isError={listQuery.isError}
        error={listQuery.error}
        onRetry={() => void listQuery.refetch()}
        isEmpty={items.length === 0}
        columns={4}
        skeleton={
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }, (_, index) => (
              <Card key={index} className="h-40 animate-pulse" />
            ))}
          </div>
        }
        empty={
          <Card>
            <EmptyState
              icon={<Link2 className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'No link matches' : 'No booking links yet'}
              description={
                hasFilters
                  ? 'Try a different search, or clear the filters.'
                  : 'A booking link is how customers reach you. Create one, share the address, and bookings start arriving in the diary.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('');
                      setTypeFilter('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Create link
                  </Button>
                ) : null
              }
            />
          </Card>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map((link) => (
            <Card key={link.id} className="flex flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold tracking-tight text-fg">
                    {link.name}
                  </h2>
                  {link.description ? (
                    <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{link.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <ActiveBadge active={link.isActive} />
                  {!link.isBookable && link.isActive ? (
                    <Badge tone="warning">Not bookable</Badge>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">
                  {LINK_TYPES.find((entry) => entry.value === link.type)?.label ?? link.type}
                </Badge>
                <Badge tone="neutral">
                  {formatNumber(link.bookingCount)} booking
                  {link.bookingCount === 1 ? '' : 's'}
                </Badge>
                {link.maxBookingsTotal !== null ? (
                  <Badge tone="info">Capped at {formatNumber(link.maxBookingsTotal)}</Badge>
                ) : null}
                {link.requiresApproval ? <Badge tone="warning">Needs approval</Badge> : null}
                {link.expiresAt !== null ? (
                  <Badge tone="neutral">Expires {formatDate(link.expiresAt, activeTimezone)}</Badge>
                ) : null}
              </div>

              {/*
               * The address is reproduced exactly as the API issues it in
               * `publicUrl` rather than rebuilt from the slug — the server owns
               * where its public surface lives, and a client that guessed would
               * hand out an address the server never agreed to.
               */}
              <CopyableUrl url={link.publicUrl} label="booking link" />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(`/b/${link.slug}`, '_blank', 'noopener')}
                  leadingIcon={<ExternalLink className="size-4" aria-hidden="true" />}
                >
                  Preview
                </Button>
                {canManage ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(link)}
                      leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger-text"
                      onClick={() => setDeleting(link)}
                      leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </DataState>

      {listQuery.data && listQuery.data.meta.totalPages > 1 ? (
        <Card>
          <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="booking links" />
        </Card>
      ) : null}

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Create a booking link'}
        description={editing ? `Public address: ${editing.publicUrl}` : undefined}
        submitLabel={editing ? 'Save changes' : 'Create link'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(linkSchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>

        {!editing ? (
          <Field
            label="Slug"
            hint="The last part of the public address. Leave blank and one is derived from the name."
            error={form.formState.errors.slug?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('slug')} placeholder="aurora-yoga-drop-in" />
            )}
          </Field>
        ) : null}

        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => (
            <Textarea
              {...field}
              {...form.register('description')}
              rows={2}
              placeholder="Book a mat in the Saturday morning class."
            />
          )}
        </Field>

        <Field
          label="Type"
          required
          hint={LINK_TYPES.find((entry) => entry.value === selectedType)?.hint}
          error={form.formState.errors.type?.message}
        >
          {(field) => (
            <Select
              {...field}
              {...form.register('type')}
              options={LINK_TYPES.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          )}
        </Field>

        {selectedType === 'SINGLE_SERVICE' ? (
          <Field label="Service" required error={form.formState.errors.serviceId?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('serviceId')}
                placeholder="Choose a service"
                options={services.items.map((service) => ({
                  value: service.id,
                  label: service.name,
                }))}
              />
            )}
          </Field>
        ) : null}

        {selectedType === 'TEAM' ? (
          <Field label="Team" required error={form.formState.errors.teamId?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('teamId')}
                placeholder="Choose a team"
                options={teams.items.map((team) => ({ value: team.id, label: team.name }))}
              />
            )}
          </Field>
        ) : null}

        {selectedType === 'STAFF' ? (
          <Field label="Provider" required error={form.formState.errors.staffProfileId?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('staffProfileId')}
                placeholder="Choose a provider"
                options={staff.items.map((profile) => ({
                  value: profile.id,
                  label: profile.displayName,
                }))}
              />
            )}
          </Field>
        ) : null}

        {selectedType === 'CATALOG' && !editing ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium text-fg">Services on offer</legend>
            <p className="text-xs text-fg-muted">
              Leave every box clear to offer the whole public catalogue.
            </p>
            {services.items.map((service) => (
              <Checkbox
                key={service.id}
                label={service.name}
                checked={catalogServiceIds.includes(service.id)}
                onChange={() =>
                  setCatalogServiceIds((current) =>
                    current.includes(service.id)
                      ? current.filter((id) => id !== service.id)
                      : [...current, service.id],
                  )
                }
              />
            ))}
          </fieldset>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Location"
            hint="Pin the link to one site, or leave open."
            error={form.formState.errors.locationId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('locationId')}
                options={filterOptions(locations.items, 'Any location', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </Field>
          <Field
            label="Total booking cap"
            hint="Blank means uncapped."
            error={form.formState.errors.maxBookingsTotal?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('maxBookingsTotal')} inputMode="numeric" />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">Extra questions</legend>
          <p className="text-xs text-fg-muted">
            Asked on the booking form and stored with the appointment. The key becomes the field
            name, so it must start with a lowercase letter.
          </p>

          {questions.map((question, index) => (
            <div
              key={question.id}
              className="flex flex-col gap-3 rounded-md border border-border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Question {index + 1}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-danger-text"
                  aria-label={`Remove question ${index + 1}`}
                  onClick={() =>
                    setQuestions((current) => current.filter((entry) => entry.id !== question.id))
                  }
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Label">
                  {(field) => (
                    <Input
                      {...field}
                      inputSize="sm"
                      value={question.label}
                      placeholder="Is this your first visit?"
                      onChange={(event) =>
                        setQuestions((current) =>
                          current.map((entry) =>
                            entry.id === question.id
                              ? { ...entry, label: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <Field label="Key">
                  {(field) => (
                    <Input
                      {...field}
                      inputSize="sm"
                      value={question.key}
                      placeholder="first_visit"
                      onChange={(event) =>
                        setQuestions((current) =>
                          current.map((entry) =>
                            entry.id === question.id
                              ? { ...entry, key: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Answer type">
                  {(field) => (
                    <Select
                      {...field}
                      selectSize="sm"
                      value={question.type}
                      options={QUESTION_TYPES.map((type) => ({
                        value: type,
                        label: type.replace('_', ' ').toLowerCase(),
                      }))}
                      onChange={(event) =>
                        setQuestions((current) =>
                          current.map((entry) =>
                            entry.id === question.id
                              ? { ...entry, type: event.target.value as QuestionType }
                              : entry,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                {CHOICE_TYPES.includes(question.type) ? (
                  <Field label="Options" hint="Comma separated.">
                    {(field) => (
                      <Input
                        {...field}
                        inputSize="sm"
                        value={question.options}
                        placeholder="Beginner, Intermediate, Advanced"
                        onChange={(event) =>
                          setQuestions((current) =>
                            current.map((entry) =>
                              entry.id === question.id
                                ? { ...entry, options: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                ) : null}
              </div>

              <Checkbox
                label="Required"
                checked={question.required}
                onChange={() =>
                  setQuestions((current) =>
                    current.map((entry) =>
                      entry.id === question.id ? { ...entry, required: !entry.required } : entry,
                    ),
                  )
                }
              />
            </div>
          ))}

          <Button
            variant="secondary"
            size="sm"
            onClick={addQuestion}
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            className="self-start"
          >
            Add a question
          </Button>
        </fieldset>

        <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <Switch
            checked={form.watch('allowStaffSelection')}
            onCheckedChange={(checked) =>
              form.setValue('allowStaffSelection', checked, { shouldDirty: true })
            }
            label="Let customers choose their provider"
            description="Turn off to let the assignment strategy decide."
          />
          <Switch
            checked={form.watch('requiresApproval')}
            onCheckedChange={(checked) =>
              form.setValue('requiresApproval', checked, { shouldDirty: true })
            }
            label="Review each booking"
            description="Bookings through this link arrive as Pending."
          />
          <Switch
            checked={form.watch('isActive')}
            onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
            label="Live"
            description="A link that is not live shows customers a closed page."
          />
        </div>
      </FormDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="Anyone following this address will see a closed page. Appointments already booked through it are unaffected."
        confirmLabel="Remove link"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
