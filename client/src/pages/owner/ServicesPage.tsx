import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Pencil, Plus, Sparkles, Trash2, Users } from 'lucide-react';
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
  filterOptions,
  ownerKeys,
  priceStep,
  toMajorUnits,
  toMinorUnits,
  toSearchParams,
  useLocationsLookup,
  useResourcesLookup,
  useServiceCategoriesLookup,
  useStaffLookup,
  type ServiceDetail,
  type ServiceResourceRequirement,
} from '@/components/owner';
import {
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
  Tabs,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { formatDuration, formatMoney } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { AssignmentStrategy, Service, ServiceCategory } from '@/types/api';

const PAGE_SIZE = 20;

const STRATEGIES: Array<{ value: AssignmentStrategy; label: string }> = [
  { value: 'SMART_MATCH', label: 'Smart match' },
  { value: 'ROUND_ROBIN', label: 'Round robin' },
  { value: 'POOLED', label: 'Pooled' },
  { value: 'LEAST_BUSY', label: 'Least busy' },
  { value: 'MANUAL', label: 'Manual' },
];

/**
 * `''` means "inherit the workspace default" for every override on this form.
 *
 * The API distinguishes three states — absent (leave alone), `null` (inherit)
 * and a number (override) — and a form that collapsed the last two would
 * silently opt every service out of the business-wide buffer policy the first
 * time anybody edited it.
 */
const inheritableNumber = (max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= max),
      message,
    );

const serviceSchema = z.object({
  name: z.string().trim().min(1, 'A service name is required.').max(160),
  categoryId: z.string().transform((value) => (value === '' ? null : value)),
  description: z
    .string()
    .trim()
    .max(4000)
    .transform((value) => (value === '' ? null : value)),
  durationMinutes: z.coerce
    .number()
    .int('Duration must be a whole number of minutes.')
    .min(1, 'A service lasts at least a minute.')
    .max(1440, 'A service cannot run longer than a day.'),
  price: z.coerce.number().min(0, 'A price cannot be negative.'),
  capacity: z.coerce.number().int().min(1, 'Capacity is at least one.').max(1000),
  preBufferMinutes: inheritableNumber(1440, 'Use 0–1440 minutes, or leave blank to inherit.'),
  postBufferMinutes: inheritableNumber(1440, 'Use 0–1440 minutes, or leave blank to inherit.'),
  minNoticeMinutes: inheritableNumber(1_051_200, 'Use minutes, or leave blank to inherit.'),
  maxHorizonDays: inheritableNumber(730, 'Use 1–730 days, or leave blank to inherit.'),
  slotIntervalMinutes: inheritableNumber(480, 'Use 1–480 minutes, or leave blank to inherit.'),
  maxPerCustomerPerDay: inheritableNumber(100, 'Use 1–100, or leave blank for no limit.'),
  assignmentStrategy: z.enum(['SMART_MATCH', 'ROUND_ROBIN', 'POOLED', 'LEAST_BUSY', 'MANUAL']),
  color: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine(
      (value) => value === null || /^#[0-9A-Fa-f]{6}$/.test(value),
      'Use a six-digit hex colour such as #0F766E.',
    ),
  requiresApproval: z.boolean(),
  isPublic: z.boolean(),
  isActive: z.boolean(),
});

type ServiceFormValues = z.input<typeof serviceSchema>;

const EMPTY_SERVICE: ServiceFormValues = {
  name: '',
  categoryId: '',
  description: '',
  durationMinutes: 60,
  price: 0,
  capacity: 1,
  preBufferMinutes: '',
  postBufferMinutes: '',
  minNoticeMinutes: '',
  maxHorizonDays: '',
  slotIntervalMinutes: '',
  maxPerCustomerPerDay: '',
  assignmentStrategy: 'SMART_MATCH',
  color: '',
  requiresApproval: false,
  isPublic: true,
  isActive: true,
};

const SERVICE_FIELDS = [
  'name',
  'categoryId',
  'description',
  'durationMinutes',
  'price',
  'capacity',
  'preBufferMinutes',
  'postBufferMinutes',
  'minNoticeMinutes',
  'maxHorizonDays',
  'slotIntervalMinutes',
  'maxPerCustomerPerDay',
  'assignmentStrategy',
  'color',
  'requiresApproval',
  'isPublic',
  'isActive',
] as const;

const categorySchema = z.object({
  name: z.string().trim().min(1, 'A category name is required.').max(120),
  description: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => (value === '' ? null : value)),
  color: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine(
      (value) => value === null || /^#[0-9A-Fa-f]{6}$/.test(value),
      'Use a six-digit hex colour.',
    ),
  sortOrder: z.coerce.number().int().min(0).max(100_000),
  isActive: z.boolean(),
});

type CategoryFormValues = z.input<typeof categorySchema>;

const EMPTY_CATEGORY: CategoryFormValues = {
  name: '',
  description: '',
  color: '',
  sortOrder: 0,
  isActive: true,
};

const CATEGORY_FIELDS = ['name', 'description', 'color', 'sortOrder', 'isActive'] as const;

function inheritedValue(value: number | null): string {
  return value === null ? '' : String(value);
}

// ---------------------------------------------------------------------------
// Who delivers it, and where
// ---------------------------------------------------------------------------

function AssignmentsDrawer({
  service,
  open,
  onClose,
}: {
  service: Service | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();
  const resources = useResourcesLookup();

  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [resourceIds, setResourceIds] = useState<string[]>([]);

  const canManage = can(PERMISSIONS.SERVICES_MANAGE);
  // Resource needs are gated on the resource permission, not the catalogue one:
  // a manager who may not touch pricing can still say which room a service
  // occupies, which is exactly why the API puts them on a different endpoint.
  const canManageResources = can(PERMISSIONS.RESOURCES_MANAGE);

  const detailQuery = useQuery({
    queryKey: ownerKeys.service(activeBusinessId, service?.id ?? ''),
    queryFn: () => api.get<ServiceDetail>(`/services/${service?.id ?? ''}`),
    enabled: open && service !== null,
  });

  const requirementsQuery = useQuery({
    queryKey: ownerKeys.serviceRequirements(activeBusinessId, service?.id ?? ''),
    queryFn: () =>
      api.get<ServiceResourceRequirement[]>(`/resources/requirements/service/${service?.id ?? ''}`),
    enabled: open && service !== null && can(PERMISSIONS.RESOURCES_READ),
  });

  const detail = detailQuery.data;

  useEffect(() => {
    if (!detail) return;
    setStaffIds(detail.staff.map((member) => member.id));
    setLocationIds(detail.locations.map((location) => location.id));
  }, [detail]);

  useEffect(() => {
    if (!requirementsQuery.data) return;
    setResourceIds(
      requirementsQuery.data
        .map((requirement) => requirement.resourceId)
        .filter((id): id is string => id !== null),
    );
  }, [requirementsQuery.data]);

  const save = useMutation<unknown, unknown, void>({
    mutationFn: async () => {
      // A PUT per set rather than one PATCH: each endpoint replaces its own set
      // wholesale, which is the contract they declare.
      await api.put(`/services/${service?.id ?? ''}/staff`, { staffProfileIds: staffIds });
      await api.put(`/services/${service?.id ?? ''}/locations`, { locationIds });
      if (canManageResources) {
        await api.put(`/resources/requirements/service/${service?.id ?? ''}`, {
          requirements: resourceIds.map((resourceId) => ({
            resourceId,
            quantity: 1,
            isRequired: true,
          })),
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'services'],
      });
      toast({ tone: 'success', title: 'Assignments saved' });
      onClose();
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not save these assignments',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={service ? `${service.name} — who, where and what it needs` : 'Assignments'}
      description="Only the people named here are ever offered for this service, only at the locations named here, and only when the resources it needs are free."
      width="lg"
      footer={
        canManage ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save assignments
            </Button>
          </>
        ) : undefined
      }
    >
      {detailQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : detailQuery.isError ? (
        <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3" disabled={!canManage}>
            <legend className="text-sm font-semibold text-fg">Providers</legend>
            {staff.items.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No staff profiles exist yet. Add one on the Staff page first.
              </p>
            ) : (
              staff.items.map((profile) => (
                <Checkbox
                  key={profile.id}
                  label={profile.displayName}
                  description={profile.title ?? undefined}
                  checked={staffIds.includes(profile.id)}
                  onChange={() => setStaffIds((current) => toggle(current, profile.id))}
                />
              ))
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3" disabled={!canManage}>
            <legend className="text-sm font-semibold text-fg">Locations</legend>
            <p className="text-xs text-fg-muted">
              Leave every box clear to offer this service everywhere.
            </p>
            {locations.items.map((location) => (
              <Checkbox
                key={location.id}
                label={location.name}
                description={location.timezone}
                checked={locationIds.includes(location.id)}
                onChange={() => setLocationIds((current) => toggle(current, location.id))}
              />
            ))}
          </fieldset>

          {can(PERMISSIONS.RESOURCES_READ) ? (
            <fieldset className="flex flex-col gap-3" disabled={!canManageResources}>
              <legend className="text-sm font-semibold text-fg">Resources it needs</legend>
              <p className="text-xs text-fg-muted">
                A resource named here is reserved for the whole appointment, so the engine will not
                offer a slot when it is already taken.
              </p>
              {resources.items.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No resources exist yet. Add rooms or equipment on the Resources page first.
                </p>
              ) : (
                resources.items.map((resource) => (
                  <Checkbox
                    key={resource.id}
                    label={resource.name}
                    description={resource.location?.name ?? 'Travels with the booking'}
                    checked={resourceIds.includes(resource.id)}
                    onChange={() => setResourceIds((current) => toggle(current, resource.id))}
                  />
                ))
              )}
            </fieldset>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoriesPanel(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const categories = useServiceCategoriesLookup();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ServiceCategory | null>(null);
  const [deleting, setDeleting] = useState<ServiceCategory | null>(null);

  const canManage = can(PERMISSIONS.SERVICES_MANAGE);

  const form = useForm<CategoryFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(categorySchema, undefined, { raw: true }),
    defaultValues: EMPTY_CATEGORY,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(
    form.setError,
    CATEGORY_FIELDS,
  );

  const open = creating || editing !== null;

  useEffect(() => {
    if (!open) return;
    clearFormError();
    form.reset(
      editing
        ? {
            name: editing.name,
            description: '',
            color: editing.color ?? '',
            sortOrder: editing.sortOrder,
            isActive: editing.isActive,
          }
        : EMPTY_CATEGORY,
    );
  }, [open, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'services'],
    });
  };

  const save = useMutation<unknown, unknown, z.output<typeof categorySchema>>({
    mutationFn: (payload) =>
      editing
        ? api.patch(`/services/categories/${editing.id}`, payload)
        : api.post('/services/categories', payload),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Category updated' : 'Category added' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/services/categories/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Category removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this category',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <p className="text-sm text-fg-muted">
            Categories group the catalogue on your public booking page.
          </p>
          {canManage ? (
            <Button
              size="sm"
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add category
            </Button>
          ) : null}
        </div>

        <DataState
          isPending={categories.isLoading}
          isError={categories.isError}
          error={categories.error}
          onRetry={categories.refetch}
          isEmpty={categories.items.length === 0}
          columns={3}
          empty={
            <EmptyState
              icon={<FolderTree className="size-6" aria-hidden="true" />}
              title="No categories yet"
              description="Categories are optional, but a catalogue with more than a handful of services reads far better grouped."
              action={
                canManage ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add category
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Service categories">
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th align="right">Order</Th>
                  <Th>Status</Th>
                  {canManage ? (
                    <Th align="right">
                      <span className="mf-sr-only">Actions</span>
                    </Th>
                  ) : null}
                </Tr>
              </THead>
              <TBody>
                {categories.items.map((category) => (
                  <Tr key={category.id}>
                    <Td>
                      <span className="flex items-center gap-2 font-medium text-fg">
                        {category.color ? (
                          <span
                            aria-hidden="true"
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                        ) : null}
                        {category.name}
                      </span>
                    </Td>
                    <Td numeric>{category.sortOrder}</Td>
                    <Td>
                      <ActiveBadge active={category.isActive} />
                    </Td>
                    {canManage ? (
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Edit ${category.name}`}
                            onClick={() => setEditing(category)}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-danger-text"
                            aria-label={`Remove ${category.name}`}
                            onClick={() => setDeleting(category)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        </DataState>
      </Card>

      <FormDrawer
        open={open}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Add a category'}
        submitLabel={editing ? 'Save changes' : 'Add category'}
        isSubmitting={save.isPending}
        formError={formError}
        width="sm"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(categorySchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>
        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => <Textarea {...field} {...form.register('description')} rows={2} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Colour" error={form.formState.errors.color?.message}>
            {(field) => (
              <Input {...field} {...form.register('color')} placeholder="#0F766E" maxLength={7} />
            )}
          </Field>
          <Field
            label="Sort order"
            hint="Lower shows first."
            error={form.formState.errors.sortOrder?.message}
          >
            {(field) => <Input {...field} {...form.register('sortOrder')} type="number" min={0} />}
          </Field>
        </div>
        <Switch
          checked={form.watch('isActive')}
          onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
          label="Shown to customers"
        />
      </FormDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="Services in this category keep working; they simply stop being grouped under it."
        confirmLabel="Remove category"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ServicesPage(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const categories = useServiceCategoriesLookup();

  const [tab, setTab] = useState<'services' | 'categories'>('services');
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [assigning, setAssigning] = useState<Service | null>(null);

  const canManage = can(PERMISSIONS.SERVICES_MANAGE);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    categoryId: categoryFilter === '' ? undefined : categoryFilter,
    isActive: activeFilter === '' ? undefined : activeFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.services(activeBusinessId, scope),
    queryFn: () => api.getPage<Service>(`/services${toSearchParams(scope)}`),
  });

  const form = useForm<ServiceFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(serviceSchema, undefined, { raw: true }),
    defaultValues: EMPTY_SERVICE,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(
    form.setError,
    SERVICE_FIELDS,
  );

  const drawerOpen = creating || editing !== null;
  // A new service is priced in the workspace currency; an existing one keeps
  // whatever it was created with.
  const currency = editing?.currency ?? listQuery.data?.items[0]?.currency ?? 'INR';

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    form.reset(
      editing
        ? {
            name: editing.name,
            categoryId: editing.categoryId ?? '',
            description: editing.description ?? '',
            durationMinutes: editing.durationMinutes,
            price: toMajorUnits(editing.priceAmount, editing.currency),
            capacity: editing.capacity,
            preBufferMinutes: inheritedValue(editing.preBufferMinutes),
            postBufferMinutes: inheritedValue(editing.postBufferMinutes),
            minNoticeMinutes: inheritedValue(editing.minNoticeMinutes),
            maxHorizonDays: inheritedValue(editing.maxHorizonDays),
            slotIntervalMinutes: inheritedValue(editing.slotIntervalMinutes),
            maxPerCustomerPerDay: inheritedValue(editing.maxPerCustomerPerDay),
            assignmentStrategy: editing.assignmentStrategy,
            color: editing.color ?? '',
            requiresApproval: editing.requiresApproval,
            isPublic: editing.isPublic,
            isActive: editing.isActive,
          }
        : EMPTY_SERVICE,
    );
  }, [drawerOpen, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'services'],
    });
  };

  const save = useMutation<Service, unknown, z.output<typeof serviceSchema>>({
    mutationFn: ({ price, ...rest }) => {
      const payload = { ...rest, priceAmount: toMinorUnits(price, currency) };
      return editing
        ? api.patch<Service>(`/services/${editing.id}`, payload)
        : api.post<Service>('/services', payload);
    },
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Service updated' : 'Service added' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/services/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Service removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this service',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters = categoryFilter !== '' || activeFilter !== '';

  return (
    <>
      <PageHeader
        title="Services"
        description="What you sell, how long it takes and who can deliver it. Everything the booking engine offers comes from here."
        actions={
          canManage && tab === 'services' ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add service
            </Button>
          ) : null
        }
      >
        <Tabs
          label="Catalogue sections"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'services', label: 'Services', icon: <Sparkles className="size-4" /> },
            { value: 'categories', label: 'Categories', icon: <FolderTree className="size-4" /> },
          ]}
        />
      </PageHeader>

      {tab === 'categories' ? (
        <CategoriesPanel />
      ) : (
        <>
          <FilterBar>
            <FilterField label="Category">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={categoryFilter}
                  onChange={(event) => {
                    setCategoryFilter(event.target.value);
                    setPage(1);
                  }}
                  options={filterOptions(categories.items, 'Every category', (category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                />
              )}
            </FilterField>
            <FilterField label="Status">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={activeFilter}
                  onChange={(event) => {
                    setActiveFilter(event.target.value);
                    setPage(1);
                  }}
                  options={[
                    { value: '', label: 'Active and inactive' },
                    { value: 'true', label: 'Active only' },
                    { value: 'false', label: 'Inactive only' },
                  ]}
                />
              )}
            </FilterField>
          </FilterBar>

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
                  icon={<Sparkles className="size-6" aria-hidden="true" />}
                  title={hasFilters ? 'No service matches these filters' : 'No services yet'}
                  description={
                    hasFilters
                      ? 'Clear the filters to see the whole catalogue.'
                      : 'Add your first service. Until one exists, there is nothing for a customer to book.'
                  }
                  action={
                    hasFilters ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setCategoryFilter('');
                          setActiveFilter('');
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
                        Add service
                      </Button>
                    ) : null
                  }
                />
              }
            >
              <TableContainer>
                <Table caption="Service catalogue">
                  <THead>
                    <Tr>
                      <Th>Service</Th>
                      <Th>Category</Th>
                      <Th align="right">Duration</Th>
                      <Th align="right">Price</Th>
                      <Th>Visibility</Th>
                      <Th align="right">
                        <span className="mf-sr-only">Actions</span>
                      </Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {items.map((service) => (
                      <Tr key={service.id}>
                        <Td>
                          <span className="flex items-center gap-2">
                            {service.color ? (
                              <span
                                aria-hidden="true"
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: service.color }}
                              />
                            ) : null}
                            <span className="font-medium text-fg">{service.name}</span>
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            {service.capacity > 1 ? (
                              <Badge tone="info">Group of {service.capacity}</Badge>
                            ) : null}
                            {service.requiresApproval ? (
                              <Badge tone="warning">Needs approval</Badge>
                            ) : null}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-sm text-fg-secondary">
                            {service.category?.name ?? 'Uncategorised'}
                          </span>
                        </Td>
                        <Td numeric>{formatDuration(service.durationMinutes)}</Td>
                        <Td numeric>{formatMoney(service.priceAmount, service.currency)}</Td>
                        <Td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ActiveBadge active={service.isActive} />
                            {!service.isPublic ? <Badge tone="neutral">Private</Badge> : null}
                          </div>
                        </Td>
                        <Td align="right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setAssigning(service)}
                              leadingIcon={<Users className="size-4" aria-hidden="true" />}
                            >
                              <span className="hidden sm:inline">Who &amp; where</span>
                            </Button>
                            {canManage ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  aria-label={`Edit ${service.name}`}
                                  onClick={() => setEditing(service)}
                                >
                                  <Pencil className="size-4" aria-hidden="true" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-danger-text"
                                  aria-label={`Remove ${service.name}`}
                                  onClick={() => setDeleting(service)}
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
                <Pagination
                  meta={listQuery.data.meta}
                  onPageChange={setPage}
                  itemLabel="services"
                />
              ) : null}
            </DataState>
          </Card>
        </>
      )}

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Add a service'}
        description="Blank overrides inherit the workspace defaults."
        submitLabel={editing ? 'Save changes' : 'Add service'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(serviceSchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>

        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => (
            <Textarea
              {...field}
              {...form.register('description')}
              rows={3}
              placeholder="Firm-pressure work on chronic tension, with room preparation either side."
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" error={form.formState.errors.categoryId?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('categoryId')}
                options={filterOptions(categories.items, 'Uncategorised', (category) => ({
                  value: category.id,
                  label: category.name,
                }))}
              />
            )}
          </Field>
          <Field
            label="Colour"
            hint="Used on the calendar so this service is recognisable at a glance."
            error={form.formState.errors.color?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('color')} placeholder="#0F766E" maxLength={7} />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Duration"
            required
            hint="Minutes"
            error={form.formState.errors.durationMinutes?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('durationMinutes')}
                type="number"
                min={1}
                max={1440}
              />
            )}
          </Field>
          <Field
            label={`Price (${currency})`}
            required
            error={form.formState.errors.price?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('price')}
                type="number"
                min={0}
                step={priceStep(currency)}
              />
            )}
          </Field>
          <Field
            label="Capacity"
            required
            hint="Above 1 makes this a group class."
            error={form.formState.errors.capacity?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('capacity')} type="number" min={1} max={1000} />
            )}
          </Field>
        </div>

        <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-fg">Buffers and limits</legend>
          <Field
            label="Buffer before"
            hint="Minutes. Blank inherits the workspace default."
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
            hint="Minutes before the start a customer may still book. Blank inherits."
            error={form.formState.errors.minNoticeMinutes?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('minNoticeMinutes')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Booking horizon"
            hint="Days ahead this may be booked. Blank inherits."
            error={form.formState.errors.maxHorizonDays?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('maxHorizonDays')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Slot interval"
            hint="Minutes between offered start times. Blank inherits."
            error={form.formState.errors.slotIntervalMinutes?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('slotIntervalMinutes')} inputMode="numeric" />
            )}
          </Field>
          <Field
            label="Per customer per day"
            hint="Blank means no limit of its own."
            error={form.formState.errors.maxPerCustomerPerDay?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('maxPerCustomerPerDay')} inputMode="numeric" />
            )}
          </Field>
        </fieldset>

        <Field
          label="Assignment strategy"
          hint="How a provider is chosen when the customer does not pick one."
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

        <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <Switch
            checked={form.watch('requiresApproval')}
            onCheckedChange={(checked) =>
              form.setValue('requiresApproval', checked, { shouldDirty: true })
            }
            label="Review each booking"
            description="Bookings arrive as Pending and wait for someone to approve them."
          />
          <Switch
            checked={form.watch('isPublic')}
            onCheckedChange={(checked) => form.setValue('isPublic', checked, { shouldDirty: true })}
            label="Listed publicly"
            description="Turn off for something only your team books on a customer's behalf."
          />
          <Switch
            checked={form.watch('isActive')}
            onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
            label="Bookable"
            description="An inactive service keeps its history but offers no new slots."
          />
        </div>
      </FormDrawer>

      <AssignmentsDrawer
        service={assigning}
        open={assigning !== null}
        onClose={() => setAssigning(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="The service is archived rather than erased — past appointments keep their record of what was booked — but no new booking can be made against it."
        confirmLabel="Remove service"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
