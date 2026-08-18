import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Pencil, Plus, Trash2 } from 'lucide-react';
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
  toSearchParams,
  useLocationsLookup,
} from '@/components/owner';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Pagination,
  Select,
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
import { formatNumber, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { Resource, ResourceType } from '@/types/api';

const PAGE_SIZE = 20;

const RESOURCE_TYPES: ResourceType[] = ['ROOM', 'EQUIPMENT', 'DESK', 'VEHICLE', 'OTHER'];

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value));

const resourceSchema = z.object({
  name: z.string().trim().min(1, 'A resource name is required.').max(160),
  type: z.enum(['ROOM', 'EQUIPMENT', 'DESK', 'VEHICLE', 'OTHER']),
  locationId: z.string().transform((value) => (value === '' ? null : value)),
  description: optionalText,
  capacity: z.coerce
    .number()
    .int('Capacity must be a whole number.')
    .min(1, 'A resource holds at least one appointment at a time.')
    .max(1000),
  color: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine(
      (value) => value === null || /^#[0-9A-Fa-f]{6}$/.test(value),
      'Use a six-digit hex colour such as #1E88E5.',
    ),
  isActive: z.boolean(),
});

type ResourceFormValues = z.input<typeof resourceSchema>;
type ResourcePayload = z.output<typeof resourceSchema>;

const EMPTY_FORM: ResourceFormValues = {
  name: '',
  type: 'ROOM',
  locationId: '',
  description: '',
  capacity: 1,
  color: '',
  isActive: true,
};

const FORM_FIELDS = [
  'name',
  'type',
  'locationId',
  'description',
  'capacity',
  'color',
  'isActive',
] as const;

function toFormValues(resource: Resource): ResourceFormValues {
  return {
    name: resource.name,
    type: resource.type,
    locationId: resource.locationId ?? '',
    description: resource.description ?? '',
    capacity: resource.capacity,
    color: resource.color ?? '',
    isActive: resource.isActive,
  };
}

/**
 * Rooms, equipment and anything else an appointment has to reserve.
 *
 * A resource is what stops two massages being booked into one treatment room.
 * Which services need which resources is edited from the service itself; this
 * page owns the resources and their capacity.
 */
export default function ResourcesPage(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();

  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [deleting, setDeleting] = useState<Resource | null>(null);

  const canManage = can(PERMISSIONS.RESOURCES_MANAGE);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    type: typeFilter === '' ? undefined : typeFilter,
    locationId: locationFilter === '' ? undefined : locationFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.resources(activeBusinessId, scope),
    queryFn: () => api.getPage<Resource>(`/resources${toSearchParams(scope)}`),
  });

  const form = useForm<ResourceFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(resourceSchema, undefined, { raw: true }),
    defaultValues: EMPTY_FORM,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(form.setError, FORM_FIELDS);

  const drawerOpen = creating || editing !== null;

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    form.reset(editing ? toFormValues(editing) : EMPTY_FORM);
  }, [drawerOpen, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'resources'],
    });
  };

  const save = useMutation<Resource, unknown, ResourcePayload>({
    mutationFn: (payload) =>
      editing
        ? api.patch<Resource>(`/resources/${editing.id}`, payload)
        : api.post<Resource>('/resources', payload),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Resource updated' : 'Resource added' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/resources/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Resource removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this resource',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters = typeFilter !== '' || locationFilter !== '';

  return (
    <>
      <PageHeader
        title="Resources"
        description="Rooms, equipment and anything else a booking has to hold. Capacity is what stops two appointments claiming the same thing at the same time."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add resource
            </Button>
          ) : null
        }
      >
        <FilterBar>
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
                  { value: '', label: 'All types' },
                  ...RESOURCE_TYPES.map((type) => ({ value: type, label: humanizeEnum(type) })),
                ]}
              />
            )}
          </FilterField>
          <FilterField label="Location">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={locationFilter}
                onChange={(event) => {
                  setLocationFilter(event.target.value);
                  setPage(1);
                }}
                options={filterOptions(locations.items, 'Every location', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
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
          columns={5}
          empty={
            <EmptyState
              icon={<Package className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'No resource matches these filters' : 'No resources yet'}
              description={
                hasFilters
                  ? 'Clear the filters to see everything this workspace reserves.'
                  : 'Add the rooms and equipment your services need. Once a service names a resource, the booking engine will not double-book it.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTypeFilter('');
                      setLocationFilter('');
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
                    Add resource
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Bookable resources">
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Location</Th>
                  <Th align="right">Capacity</Th>
                  <Th>Status</Th>
                  {canManage ? (
                    <Th align="right">
                      <span className="mf-sr-only">Actions</span>
                    </Th>
                  ) : null}
                </Tr>
              </THead>
              <TBody>
                {items.map((resource) => (
                  <Tr key={resource.id}>
                    <Td>
                      <span className="flex items-center gap-2">
                        {resource.color ? (
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: resource.color }}
                          />
                        ) : null}
                        <span className="font-medium text-fg">{resource.name}</span>
                      </span>
                      {resource.description ? (
                        <span className="block max-w-md truncate text-xs text-fg-muted">
                          {resource.description}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {humanizeEnum(resource.type)}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {resource.location?.name ?? 'Travels with the booking'}
                      </span>
                    </Td>
                    <Td align="right" numeric>
                      {formatNumber(resource.capacity)}
                    </Td>
                    <Td>
                      <ActiveBadge active={resource.isActive} />
                    </Td>
                    {canManage ? (
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Edit ${resource.name}`}
                            onClick={() => setEditing(resource)}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-danger-text"
                            aria-label={`Remove ${resource.name}`}
                            onClick={() => setDeleting(resource)}
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

          {listQuery.data ? (
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="resources" />
          ) : null}
        </DataState>
      </Card>

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Add a resource'}
        submitLabel={editing ? 'Save changes' : 'Add resource'}
        isSubmitting={save.isPending}
        formError={formError}
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(resourceSchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required error={form.formState.errors.type?.message}>
            {(field) => (
              <Select
                {...field}
                {...form.register('type')}
                options={RESOURCE_TYPES.map((type) => ({
                  value: type,
                  label: humanizeEnum(type),
                }))}
              />
            )}
          </Field>

          <Field
            label="Location"
            hint="Leave unset for something that travels with the appointment."
            error={form.formState.errors.locationId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('locationId')}
                options={filterOptions(locations.items, 'No fixed location', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </Field>
        </div>

        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => <Textarea {...field} {...form.register('description')} rows={2} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Capacity"
            required
            hint="How many appointments may hold this at the same instant."
            error={form.formState.errors.capacity?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('capacity')}
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
              />
            )}
          </Field>

          <Field
            label="Colour"
            hint="Six-digit hex, used to tell resources apart at a glance."
            error={form.formState.errors.color?.message}
          >
            {(field) => (
              <Input {...field} {...form.register('color')} placeholder="#0EA5E9" maxLength={7} />
            )}
          </Field>
        </div>

        <Switch
          checked={form.watch('isActive')}
          onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
          label="Available for booking"
          description="An inactive resource is never reserved, and services that require it stop being bookable."
        />
      </FormDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="Services that require this resource will stop offering slots until you edit their requirements. Past bookings keep their record."
        confirmLabel="Remove resource"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
