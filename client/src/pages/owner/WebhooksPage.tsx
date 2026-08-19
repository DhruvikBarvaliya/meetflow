import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  CopyButton,
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  ownerKeys,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
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
  Textarea,
  Th,
  Tr,
  useToast,
  type BadgeTone,
  type SelectOption,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { isApiError } from '@/lib/apiClient';
import { formatDateTime, formatNumber, formatRelative, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import {
  SUBSCRIBABLE_WEBHOOK_EVENTS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_WILDCARD_EVENT,
  type CreatedWebhookEndpoint,
  type WebhookDeliveryFilters,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookFilters,
} from '@/types/api';
import {
  createWebhook,
  deleteWebhook,
  deliveryScope,
  fetchWebhookDeliveries,
  fetchWebhooks,
  sendWebhookTest,
  updateWebhook,
  webhookScope,
  workspaceKeys,
} from './workspaceApi';

/**
 * Outbound events: where this workspace sends them, and whether they arrive.
 *
 * The delivery worker, the queue, the HMAC signing and both tables all shipped
 * before there was any way to register an endpoint, so the subsystem was
 * reachable only by inserting a row by hand. This page is the way in.
 *
 * Two things about the contract shape everything below.
 *
 * **The signing secret is returned exactly once.** It exists in one variable, in
 * one function on the server, and the 201 from `POST /webhooks` is the only
 * place it is ever readable — there is no endpoint that can fetch it back and no
 * rotation endpoint to recover from losing it. So the secret dialog does not
 * dismiss on a backdrop click, says plainly that this is the only showing, and
 * names the actual remedy (delete the endpoint and register another) rather than
 * implying somebody can look it up later.
 *
 * **Reading and managing are different permissions, and the split is not
 * cosmetic.** `webhooks:read` exposes delivery history — URLs, response bodies,
 * error text — which is operational debugging data a manager needs.
 * `webhooks:manage` is what lets somebody point a tenant's event stream at a
 * server of their choosing, which is a materially larger act and is granted to
 * owners alone by the built-in roles. A manager therefore sees this whole page
 * and can act on none of it, which is a legitimate state rather than a bug, and
 * the page says so instead of showing buttons that would 403.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Delivery pills.
 *
 * FAILED is the only red one, and CANCELLED is not: a cancelled delivery was
 * addressed to an endpoint that had already been switched off, so it is a
 * consequence of a decision somebody made rather than something going wrong.
 * Colouring them alike would send an operator hunting for a fault that is
 * really a disabled endpoint.
 */
const DELIVERY_TONES: Record<WebhookDeliveryStatus, BadgeTone> = {
  PENDING: 'neutral',
  PROCESSING: 'info',
  DELIVERED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

/**
 * The count at which the worker switches an endpoint off, from
 * `FAILURE_THRESHOLD` in server/src/jobs/processors/webhook.processor.ts.
 *
 * Shown rather than kept as a private constant because "seven failures" means
 * nothing without knowing what it is seven out of. Re-activating resets the
 * counter to zero — a re-enable is a fresh start, not a resumption, or the very
 * next failure would switch the endpoint straight back off.
 */
const FAILURE_THRESHOLD = 20;

/** From `MAX_ENDPOINTS_PER_BUSINESS` in webhooks.service.ts. */
const MAX_ENDPOINTS = 20;

const EVENT_DESCRIPTIONS: Record<string, string> = {
  'appointment.created': 'A booking was made, by anyone, through any surface.',
  'appointment.rescheduled': 'A booking moved to a different time.',
  'appointment.cancelled': 'A booking was cancelled.',
  'appointment.completed': 'A booking was marked as attended.',
  'appointment.no_show': 'The customer did not turn up.',
};

const EMPTY_FILTERS: WebhookFilters = { page: 1, isActive: '', event: '' };

const EMPTY_DELIVERY_FILTERS: WebhookDeliveryFilters = { page: 1, status: '', event: '' };

/** `appointment.no_show` → `Appointment no show`. */
function humaniseEvent(event: string): string {
  return event === WEBHOOK_WILDCARD_EVENT ? 'Every event' : humanizeEnum(event.replace(/\./g, ' '));
}

function subscribesToAll(events: string[]): boolean {
  return events.includes(WEBHOOK_WILDCARD_EVENT);
}

// ---------------------------------------------------------------------------
// The one showing of the signing secret
// ---------------------------------------------------------------------------

/**
 * Shown once, immediately after creation, and never again.
 *
 * `dismissOnBackdrop` is false and there is no cancel button: every way out of
 * this dialog is an explicit act, because a stray click here costs the user the
 * secret. The wording states the consequence in the present tense rather than
 * warning about a future one — by the time this is on screen the only copy
 * outside the database is the text in front of them.
 */
function SigningSecretDialog({
  endpoint,
  onClose,
}: {
  endpoint: CreatedWebhookEndpoint | null;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={endpoint !== null}
      onClose={onClose}
      title="Copy this signing secret now"
      description="This is the only time it is shown. MeetFlow keeps no readable copy, and no endpoint can return it again."
      width="md"
      dismissOnBackdrop={false}
      footer={
        <Button onClick={onClose} variant="primary">
          I have stored it
        </Button>
      }
    >
      {endpoint ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Endpoint</p>
            <p className="break-all font-mono text-xs text-fg-secondary">{endpoint.url}</p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Signing secret
            </p>
            <div className="flex items-center gap-2">
              <code className="mf-scroll-x min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-fg">
                {endpoint.signingSecret}
              </code>
              <CopyButton value={endpoint.signingSecret} label="signing secret" />
            </div>
          </div>

          <div className="rounded-lg border border-warning-border bg-warning-subtle p-4">
            <p className="text-sm leading-relaxed text-warning-text">
              Your server uses this to verify that a delivery came from MeetFlow. If you close this
              without storing it, the endpoint keeps working but you can never verify a delivery
              against it — the only way back is to delete this endpoint and register another, which
              issues a new secret.
            </p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delivery history
// ---------------------------------------------------------------------------

/**
 * What actually happened to the events sent to one endpoint.
 *
 * The columns are chosen so a failing endpoint is obvious without opening
 * anything: the status, the response code the subscriber returned, how many of
 * the permitted attempts have been spent, and the last error text. A history
 * that showed only "failed" would send somebody to their own server logs to
 * learn something this table already knows.
 */
function DeliveryDrawer({
  endpoint,
  open,
  onClose,
}: {
  endpoint: WebhookEndpoint | null;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const [filters, setFilters] = useState<WebhookDeliveryFilters>(EMPTY_DELIVERY_FILTERS);

  const endpointId = endpoint?.id ?? '';

  useEffect(() => {
    if (open) setFilters(EMPTY_DELIVERY_FILTERS);
  }, [open, endpointId]);

  const deliveriesQuery = useQuery({
    queryKey: workspaceKeys.webhookDeliveries(activeBusinessId, endpointId, deliveryScope(filters)),
    queryFn: () => fetchWebhookDeliveries(endpointId, filters),
    enabled: open && endpointId !== '',
    placeholderData: (previous) => previous,
  });

  const rows = deliveriesQuery.data?.items ?? [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Delivery history"
      description={endpoint?.url}
      width="lg"
    >
      <div className="flex flex-col gap-4">
        <FilterBar label="Delivery filters">
          <FilterField label="Status">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    page: 1,
                    status: event.target.value as WebhookDeliveryFilters['status'],
                  }))
                }
                options={[
                  { value: '', label: 'Every status' },
                  ...WEBHOOK_DELIVERY_STATUSES.map((status) => ({
                    value: status,
                    label: humanizeEnum(status),
                  })),
                ]}
              />
            )}
          </FilterField>
          <FilterField label="Event">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={filters.event}
                placeholder="appointment.created"
                onChange={(event) =>
                  setFilters((current) => ({ ...current, page: 1, event: event.target.value }))
                }
              />
            )}
          </FilterField>
        </FilterBar>

        <DataState
          isPending={deliveriesQuery.isPending}
          isError={deliveriesQuery.isError}
          error={deliveriesQuery.error}
          onRetry={() => void deliveriesQuery.refetch()}
          isEmpty={rows.length === 0}
          rows={4}
          columns={3}
          empty={
            <EmptyState
              icon={<History className="size-6" aria-hidden="true" />}
              title={
                filters.status !== '' || filters.event !== ''
                  ? 'No deliveries match'
                  : 'Nothing has been sent yet'
              }
              description={
                filters.status !== '' || filters.event !== ''
                  ? 'Try a different status, or clear the event name.'
                  : 'A row appears here the first time one of the subscribed events happens, or as soon as you send a test.'
              }
            />
          }
        >
          <ul className="flex flex-col gap-2">
            {rows.map((delivery) => (
              <li
                key={delivery.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={DELIVERY_TONES[delivery.status]} dot>
                    {humanizeEnum(delivery.status)}
                  </Badge>
                  <span className="font-mono text-xs text-fg">{delivery.event}</span>
                  <span className="ml-auto text-xs tabular-nums text-fg-muted">
                    {formatDateTime(delivery.createdAt, activeTimezone)}
                  </span>
                </div>

                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  <div className="flex gap-1.5">
                    <dt className="text-fg-muted">Response</dt>
                    <dd className="tabular-nums text-fg-secondary">
                      {/*
                       * Null means the request never got an answer — a timeout, a
                       * refused connection, a name that does not resolve — which
                       * is a different fault from a 500 and sends the reader
                       * somewhere different. A dash would conflate the two.
                       */}
                      {delivery.responseStatus === null
                        ? 'No response'
                        : formatNumber(delivery.responseStatus)}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-fg-muted">Attempts</dt>
                    <dd className="tabular-nums text-fg-secondary">
                      {delivery.attemptCount} of {delivery.maxAttempts}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-fg-muted">Delivered</dt>
                    <dd className="text-fg-secondary">
                      {delivery.deliveredAt === null
                        ? 'Not yet'
                        : formatRelative(delivery.deliveredAt, activeTimezone)}
                    </dd>
                  </div>
                </dl>

                {delivery.error !== null && delivery.error !== '' ? (
                  <p className="break-all rounded-md bg-danger-subtle px-2 py-1 font-mono text-xs leading-relaxed text-danger-text">
                    {delivery.error}
                  </p>
                ) : null}

                {delivery.responseBody !== null && delivery.responseBody !== '' ? (
                  <pre className="mf-scroll-x max-h-32 overflow-y-auto rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-xs leading-relaxed text-fg-secondary">
                    {delivery.responseBody}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>

          {deliveriesQuery.data ? (
            <Pagination
              meta={deliveriesQuery.data.meta}
              onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
              itemLabel="deliveries"
            />
          ) : null}
        </DataState>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/**
 * Mirrors `webhookUrlSchema` in webhooks.validation.ts, including the two
 * refinements the API adds beyond "is a URL": the scheme has to be http or
 * https, and credentials in the URL are refused because they would end up in the
 * log pipeline and in an audit-readable column while buying nothing the HMAC
 * signature does not already provide.
 */
const urlSchema = z
  .string()
  .trim()
  .min(1, 'A delivery URL is required.')
  .max(2048)
  .url('Enter a complete URL, including the scheme.')
  .refine((value) => /^https?:\/\//i.test(value), 'Use an http:// or https:// URL.')
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.username === '' && parsed.password === '';
    } catch {
      // Unreachable behind `.url()`, but a thrown constructor here would surface
      // as a crash rather than as a field error.
      return false;
    }
  }, 'Do not put credentials in the URL; the signing secret authenticates deliveries.');

/**
 * `subscribeToAll` is a form-only field, not something the API knows about.
 *
 * The wildcard and a named list are one field on the wire — `events: ['*']`
 * versus `events: ['appointment.created', …]` — and the server refuses a list
 * that mixes them, since the wildcard already covers everything. Splitting the
 * choice in two here is what makes that impossible to express rather than
 * something to validate: the submit handler builds the array from whichever
 * branch the switch is on.
 */
const webhookSchema = z
  .object({
    url: urlSchema,
    description: z.string().trim().max(500),
    subscribeToAll: z.boolean(),
    events: z.array(z.string()),
    isActive: z.boolean(),
  })
  // Mirrors `webhookEventsSchema`'s `min(1)`. Caught here rather than left to
  // the API so the message lands on the checkbox list the reader is looking at,
  // instead of arriving as a banner after a round trip.
  .refine((value) => value.subscribeToAll || value.events.length > 0, {
    path: ['events'],
    message: 'Choose at least one event, or turn the wildcard back on.',
  });

type WebhookFormValues = z.input<typeof webhookSchema>;

const FORM_FIELDS = ['url', 'description', 'events', 'isActive'] as const;

const EMPTY_FORM: WebhookFormValues = {
  url: '',
  description: '',
  subscribeToAll: true,
  events: [],
  isActive: true,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WebhooksPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [filters, setFilters] = useState<WebhookFilters>(EMPTY_FILTERS);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [viewingHistory, setViewingHistory] = useState<WebhookEndpoint | null>(null);
  const [freshSecret, setFreshSecret] = useState<CreatedWebhookEndpoint | null>(null);

  const canManage = can(PERMISSIONS.WEBHOOKS_MANAGE);

  const listQuery = useQuery({
    queryKey: workspaceKeys.webhooks(activeBusinessId, webhookScope(filters)),
    queryFn: () => fetchWebhooks(filters),
    placeholderData: (previous) => previous,
  });

  const form = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
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
            url: editing.url,
            description: editing.description ?? '',
            subscribeToAll: subscribesToAll(editing.events),
            events: subscribesToAll(editing.events) ? [] : editing.events,
            isActive: editing.isActive,
          }
        : EMPTY_FORM,
    );
  }, [drawerOpen, editing, form, clearFormError]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'webhooks'],
    });
  };

  const save = useMutation<WebhookEndpoint | CreatedWebhookEndpoint, unknown, WebhookFormValues>({
    mutationFn: (values) => {
      const events = values.subscribeToAll ? [WEBHOOK_WILDCARD_EVENT] : values.events;
      const body = {
        url: values.url,
        description: values.description === '' ? null : values.description,
        events,
        isActive: values.isActive,
      };
      return editing ? updateWebhook(editing.id, body) : createWebhook(body);
    },
    onSuccess: (endpoint) => {
      invalidate();
      setCreating(false);
      setEditing(null);
      if ('signingSecret' in endpoint) {
        // The dialog is the success message, so no toast competes with it for
        // attention. A toast that auto-dismisses beside a secret shown once
        // would be teaching the wrong lesson about which of the two matters.
        setFreshSecret(endpoint);
      } else {
        toast({ tone: 'success', title: 'Endpoint updated' });
      }
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, WebhookEndpoint>({
    mutationFn: (endpoint) => deleteWebhook(endpoint.id),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Endpoint deleted' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not delete this endpoint',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const test = useMutation<unknown, unknown, WebhookEndpoint>({
    mutationFn: (endpoint) => sendWebhookTest(endpoint.id),
    onSuccess: (_delivery, endpoint) => {
      invalidate();
      toast({
        tone: 'success',
        title: 'Test event queued',
        // Queued, not delivered: the row is committed before the queue hears
        // about it, so claiming success here would be a claim this client has no
        // basis for. The history is where the outcome actually appears.
        description: 'Open the delivery history in a moment to see how your server answered.',
      });
      setViewingHistory(endpoint);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not send a test event',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters = filters.isActive !== '' || filters.event !== '';
  const subscribeToAll = form.watch('subscribeToAll');
  const chosenEvents = form.watch('events');

  const eventOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: 'Every event' },
      { value: WEBHOOK_WILDCARD_EVENT, label: 'Wildcard subscribers' },
      ...SUBSCRIBABLE_WEBHOOK_EVENTS.map((event) => ({
        value: event,
        label: humaniseEvent(event),
      })),
    ],
    [],
  );

  const toggleEvent = (event: string, checked: boolean): void => {
    const next = checked
      ? [...chosenEvents, event]
      : chosenEvents.filter((value) => value !== event);
    form.setValue('events', next, { shouldDirty: true });
  };

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Where this workspace sends its events, and whether they are arriving. Each delivery is signed, so your server can prove it came from MeetFlow."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add endpoint
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <FilterField label="State">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.isActive}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    page: 1,
                    isActive: event.target.value as WebhookFilters['isActive'],
                  }))
                }
                options={[
                  { value: '', label: 'Active and disabled' },
                  { value: 'true', label: 'Active only' },
                  { value: 'false', label: 'Disabled only' },
                ]}
              />
            )}
          </FilterField>
          <FilterField label="Subscribed to" className="min-w-[12rem]">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={filters.event}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, page: 1, event: event.target.value }))
                }
                options={eventOptions}
              />
            )}
          </FilterField>
          {hasFilters ? (
            <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          ) : null}
        </FilterBar>

        {!canManage ? (
          <p className="text-xs leading-relaxed text-fg-muted">
            Your role can read endpoints and their delivery history, which is what debugging a
            failing integration needs. Registering, editing and testing an endpoint needs
            webhooks:manage — pointing a workspace&apos;s event stream at a server is a larger act
            than reading it, so the built-in roles grant it to owners alone.
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
              icon={<Webhook className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'No endpoint matches' : 'No endpoints registered'}
              description={
                hasFilters
                  ? 'Try a different state, or a different event.'
                  : 'Register a URL and MeetFlow will POST a signed JSON body to it whenever one of the events you choose happens.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add endpoint
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Registered webhook endpoints and how their recent deliveries have gone.">
              <THead>
                <Tr>
                  <Th>Endpoint</Th>
                  <Th>Events</Th>
                  <Th>State</Th>
                  <Th>Last delivery</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((endpoint) => (
                  <Tr key={endpoint.id} interactive>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setViewingHistory(endpoint)}
                        className="block max-w-xs rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <span className="block truncate font-mono text-xs text-fg">
                          {endpoint.url}
                        </span>
                        {endpoint.description ? (
                          <span className="block truncate text-xs text-fg-muted">
                            {endpoint.description}
                          </span>
                        ) : null}
                      </button>
                    </Td>
                    <Td>
                      {subscribesToAll(endpoint.events) ? (
                        <Badge tone="brand">Every event</Badge>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {endpoint.events.map((event) => (
                            <Badge key={event} tone="neutral">
                              {humaniseEvent(event)}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="flex flex-col items-start gap-1">
                        <Badge tone={endpoint.isActive ? 'success' : 'neutral'} dot>
                          {endpoint.isActive ? 'Active' : 'Disabled'}
                        </Badge>
                        {/*
                         * A failure count is only worth showing while it is
                         * counting up towards something. At zero it is noise; on
                         * a disabled endpoint the disabled badge already carries
                         * the news.
                         */}
                        {endpoint.isActive && endpoint.failureCount > 0 ? (
                          <span className="text-xs tabular-nums text-danger-text">
                            {endpoint.failureCount} of {FAILURE_THRESHOLD} failures before this
                            switches off
                          </span>
                        ) : null}
                        {!endpoint.isActive && endpoint.disabledAt !== null ? (
                          <span className="text-xs text-fg-muted">
                            Off since {formatRelative(endpoint.disabledAt, activeTimezone)}
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    <Td>
                      {/*
                       * Both timestamps, not the more recent of the two. "Last
                       * succeeded three weeks ago, last failed four minutes ago"
                       * is the sentence that identifies a broken integration,
                       * and collapsing it to one line loses exactly that.
                       */}
                      <span className="flex flex-col gap-0.5 text-xs">
                        <span className="text-success-text">
                          {endpoint.lastSuccessAt === null
                            ? 'Never succeeded'
                            : `Succeeded ${formatRelative(endpoint.lastSuccessAt, activeTimezone)}`}
                        </span>
                        <span
                          className={
                            endpoint.lastFailureAt === null ? 'text-fg-muted' : 'text-danger-text'
                          }
                        >
                          {endpoint.lastFailureAt === null
                            ? 'No failures'
                            : `Failed ${formatRelative(endpoint.lastFailureAt, activeTimezone)}`}
                        </span>
                      </span>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setViewingHistory(endpoint)}
                          leadingIcon={<History className="size-4" aria-hidden="true" />}
                        >
                          History
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Send a test event to ${endpoint.url}`}
                              // A test event to a disabled endpoint is cancelled
                              // by the worker, so the API refuses it with a 409.
                              // The reason is on screen in the State column
                              // rather than hidden behind this control.
                              disabled={!endpoint.isActive || test.isPending}
                              onClick={() => test.mutate(endpoint)}
                            >
                              <Send className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Edit ${endpoint.url}`}
                              onClick={() => setEditing(endpoint)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-danger-text"
                              aria-label={`Delete ${endpoint.url}`}
                              onClick={() => setDeleting(endpoint)}
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
              onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
              itemLabel="endpoints"
            />
          ) : null}
        </DataState>
      </Card>

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? 'Edit endpoint' : 'Add an endpoint'}
        submitLabel={editing ? 'Save changes' : 'Create endpoint'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(values);
        })}
      >
        {editing ? null : (
          <p className="text-sm leading-relaxed text-fg-secondary">
            A signing secret is generated when the endpoint is created and shown to you once, on the
            next screen. Have somewhere to store it before you continue. A workspace can hold up to{' '}
            {MAX_ENDPOINTS} endpoints.
          </p>
        )}

        <Field
          label="Delivery URL"
          required
          hint="http and https are both accepted; the signature is what authenticates a delivery either way."
          error={form.formState.errors.url?.message}
        >
          {(field) => (
            <Input
              {...field}
              {...form.register('url')}
              type="url"
              placeholder="https://example.com/hooks/meetflow"
              autoComplete="off"
            />
          )}
        </Field>

        <Field
          label="What this endpoint is for"
          hint="Yours only. Shown in this list so a colleague can tell two endpoints apart."
          error={form.formState.errors.description?.message}
        >
          {(field) => <Textarea {...field} {...form.register('description')} rows={2} />}
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg">Events</legend>

          <Switch
            checked={subscribeToAll}
            onCheckedChange={(checked) =>
              form.setValue('subscribeToAll', checked, { shouldDirty: true })
            }
            label="Send every event"
            description="Includes events added to MeetFlow later, so an integration built against the wildcard does not need changing when the catalogue grows."
          />

          {subscribeToAll ? null : (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              {SUBSCRIBABLE_WEBHOOK_EVENTS.map((event) => (
                <Checkbox
                  key={event}
                  checked={chosenEvents.includes(event)}
                  onChange={(changed) => toggleEvent(event, changed.target.checked)}
                  label={<span className="font-mono text-xs">{event}</span>}
                  description={EVENT_DESCRIPTIONS[event]}
                />
              ))}
              {form.formState.errors.events?.message ? (
                <p className="text-xs leading-relaxed text-danger-text">
                  {form.formState.errors.events.message}
                </p>
              ) : chosenEvents.length === 0 ? (
                <p className="text-xs leading-relaxed text-fg-muted">
                  An endpoint subscribed to nothing would never be sent anything.
                </p>
              ) : null}
            </div>
          )}
        </fieldset>

        <Switch
          checked={form.watch('isActive')}
          onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
          label="Deliver to this endpoint"
          description={
            editing && !editing.isActive
              ? 'Turning this back on also clears the failure counter, so the endpoint starts from zero rather than one failure away from switching off again.'
              : 'Turn this off to keep the registration and stop the deliveries. Anything queued for a disabled endpoint is cancelled rather than held.'
          }
        />
      </FormDrawer>

      <DeliveryDrawer
        endpoint={viewingHistory}
        open={viewingHistory !== null}
        onClose={() => setViewingHistory(null)}
      />

      <SigningSecretDialog endpoint={freshSecret} onClose={() => setFreshSecret(null)} />

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
        title="Delete this endpoint?"
        description={
          <>
            <span className="block break-all font-mono text-xs text-fg">{deleting?.url}</span>
            <span className="mt-2 block">
              Deliveries stop immediately and its signing secret becomes unusable. Registering the
              same URL again issues a new secret, so whatever is verifying deliveries on your side
              will need updating. The delivery history goes with it.
            </span>
          </>
        }
        confirmLabel="Delete endpoint"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
