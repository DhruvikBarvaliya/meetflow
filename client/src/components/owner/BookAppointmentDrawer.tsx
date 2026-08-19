import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Info } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useId, useRef, useState } from 'react';
import { SlotPicker } from '@/components/scheduling/SlotPicker';
import {
  Badge,
  Button,
  Drawer,
  Field,
  Input,
  Select,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import {
  customerName,
  formatDateLong,
  formatDuration,
  formatMoney,
  formatTime,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import type { AppointmentStatus, Customer } from '@/types/api';
import { SearchField, useDebouncedValue } from './filters';
import { ownerKeys, toSearchParams } from './queryKeys';
import { useLocationsLookup, useServicesLookup, useStaffLookup } from './useWorkspaceLookups';

/**
 * Taking a booking on the workspace's own side of the counter.
 *
 * `POST /appointments` has existed since the API shipped and nothing in this
 * client called it, which meant a receptionist holding a telephone had no way
 * to put the caller in the diary: the only door into the schedule was a
 * customer following a public link. This is that door.
 *
 * Four things here are deliberate rather than incidental.
 *
 * **The provider is chosen, not inferred.** `createAppointmentSchema` requires
 * `staffProfileId` where the public flow leaves it optional, and the server
 * says why: staff-side booking is deliberate assignment, not Smart Match. So
 * the form asks who is delivering it before it offers a single time, and the
 * availability search is run against that one person.
 *
 * **The times come from the scheduling engine.** `SlotPicker` reads
 * `GET /appointments/availability/slots`, which has already applied the
 * service's buffers, the provider's rota, resource contention, holidays and the
 * workspace's notice period. A free-text time control would let someone promise
 * a caller a slot the booking endpoint then refuses, which is the worst possible
 * moment to discover it.
 *
 * **No location is asked for, and that is a correctness decision.** The search
 * runs without a `locationId`, so the engine resolves the site as
 * `profile.defaultLocationId`; `verifySlot` on the booking path resolves it by
 * the identical expression. Sending a location the search never considered
 * would mean confirming against a different question from the one that was
 * asked, and the two answers can disagree. The provider's default site is shown
 * read-only instead, so the receptionist can still tell the caller where to
 * come. Offering a choice properly means threading `locationId` through the
 * picker's own query as well, which is a change to `SlotPicker`.
 *
 * **A double submit cannot become two appointments.** Every attempt carries an
 * `X-Idempotency-Key`; see `idempotencyKeyFor` for how one key is held across
 * retries of the same booking and abandoned the moment the booking changes.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The appointment as the 201 carries it.
 *
 * Narrower than `Appointment` in `@/types/api` on purpose: the create response
 * is the Sequelize row, so it has the columns and none of the joined
 * `service` / `staffProfile` / `customer` objects a list row carries. Typing it
 * as the list shape would promise nested objects that are simply not there.
 */
export interface BookedAppointment {
  id: string;
  publicId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timezone: string;
  requiresApproval: boolean;
}

/** The full 201 body. `meta.replayed` sits beside it, not inside it. */
interface BookingCreated {
  appointment: BookedAppointment;
  participant: { id: string; publicId: string; role: string; status: string };
  customer: {
    id: string;
    publicId: string;
    firstName: string;
    lastName: string | null;
    email: string;
  };
}

/** Exactly the body `POST /appointments` accepts — the schema is `.strict()`. */
interface CreateAppointmentBody {
  serviceId: string;
  staffProfileId: string;
  startsAt: string;
  timezone: string;
  customer: {
    id?: string;
    firstName: string;
    lastName?: string;
    email: string;
    phone?: string;
  };
  customerNotes?: string;
}

export interface BookAppointmentDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Fired once the booking is durable, so the caller can refresh its list. */
  onBooked?: (appointment: BookedAppointment) => void;
  /** The day the caller was already looking at, as `YYYY-MM-DD` in the workspace zone. */
  initialDate?: string | null;
  /** The provider whose column or filter the caller was already in. */
  initialStaffProfileId?: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Which half of the customer step is in use. */
type CustomerMode = 'existing' | 'new';

interface CustomerDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const EMPTY_CUSTOMER: CustomerDraft = { firstName: '', lastName: '', email: '', phone: '' };

/** The field keys this form can attach a message to, server-sent or local. */
type FieldKey =
  'serviceId' | 'staffProfileId' | 'startsAt' | 'customerId' | 'firstName' | 'email' | 'phone';

/**
 * The server's dotted paths, mapped onto the inputs this form actually renders.
 *
 * A 422 naming `customer.email` has to land on the email box rather than in the
 * banner, or the person filling the form is left hunting for which of eight
 * controls the message is about. Anything not in this table stays a banner,
 * which is the honest outcome for a field with nowhere to put it.
 */
const SERVER_FIELD_MAP: Record<string, FieldKey> = {
  serviceId: 'serviceId',
  staffProfileId: 'staffProfileId',
  startsAt: 'startsAt',
  'customer.firstName': 'firstName',
  'customer.email': 'email',
  'customer.phone': 'phone',
};

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export function BookAppointmentDrawer({
  open,
  onClose,
  onBooked,
  initialDate = null,
  initialStaffProfileId = null,
}: BookAppointmentDrawerProps): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const formId = useId();

  const services = useServicesLookup();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();

  const canSearch = can(PERMISSIONS.AVAILABILITY_READ);
  const canPickCustomer =
    can(PERMISSIONS.CUSTOMERS_READ) || can(PERMISSIONS.CUSTOMERS_READ_ASSIGNED);

  const [serviceId, setServiceId] = useState('');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [mode, setMode] = useState<CustomerMode>('existing');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_CUSTOMER);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const debouncedCustomerSearch = useDebouncedValue(customerSearch);

  /*
   * One key per booking, held across retries of that booking and no further.
   *
   * The server hashes (business, service, provider, location, start, email) and
   * answers 409 IDEMPOTENCY_KEY_REUSED when the same key arrives with a
   * different payload — deliberately, because silently replaying the first
   * result would hide a booking the caller believes they just made. So the key
   * is keyed on the same facts: press the button twice, or lose the response to
   * a flaky connection and press it again, and both attempts resolve to one
   * appointment; change the time or the customer first and the next attempt is
   * a genuinely different booking with a key of its own.
   *
   * A ref rather than state because nothing renders from it, and deriving it at
   * submit time rather than in an effect means there is no window in which the
   * key and the payload it is meant to describe disagree.
   */
  const attemptRef = useRef<{ signature: string; key: string } | null>(null);

  function idempotencyKeyFor(signature: string): string {
    if (attemptRef.current?.signature !== signature) {
      attemptRef.current = { signature, key: crypto.randomUUID() };
    }
    return attemptRef.current.key;
  }

  /*
   * Reopening must not inherit the last booking's answers — least of all its
   * customer, which is how somebody ends up in a diary they never asked for.
   * The workspace's today is the starting day, or whichever day the caller was
   * already looking at.
   */
  useEffect(() => {
    if (!open) return;
    setServiceId('');
    setStaffProfileId(initialStaffProfileId ?? '');
    setDate(initialDate ?? DateTime.now().setZone(activeTimezone).toISODate());
    setStartsAt(null);
    setMode(canPickCustomer ? 'existing' : 'new');
    setCustomerSearch('');
    setCustomerId('');
    setDraft(EMPTY_CUSTOMER);
    setNotes('');
    setErrors({});
    setFormError(null);
    attemptRef.current = null;
  }, [open, initialDate, initialStaffProfileId, activeTimezone, canPickCustomer]);

  const customerScope = {
    pageSize: 20,
    search: debouncedCustomerSearch === '' ? undefined : debouncedCustomerSearch,
  };

  const customersQuery = useQuery({
    queryKey: ownerKeys.customers(activeBusinessId, customerScope),
    queryFn: () => api.getPage<Customer>(`/customers${toSearchParams(customerScope)}`),
    enabled: open && canPickCustomer && mode === 'existing',
  });

  const customers = customersQuery.data?.items ?? [];
  const chosenCustomer = customers.find((row) => row.id === customerId) ?? null;

  const service = services.items.find((row) => row.id === serviceId) ?? null;
  const provider = staff.items.find((row) => row.id === staffProfileId) ?? null;
  const defaultLocationId = provider?.defaultLocationId ?? null;
  const providerLocation =
    defaultLocationId === null
      ? null
      : (locations.items.find((row) => row.id === defaultLocationId) ?? null);

  const book = useMutation<
    { created: BookingCreated; replayed: boolean },
    unknown,
    CreateAppointmentBody
  >({
    mutationFn: async (payload) => {
      const signature = [
        payload.serviceId,
        payload.staffProfileId,
        payload.startsAt,
        payload.customer.id ?? payload.customer.email,
      ].join('|');

      const response = await api.postWithMeta<BookingCreated>('/appointments', payload, {
        headers: { 'X-Idempotency-Key': idempotencyKeyFor(signature) },
      });
      return { created: response.data, replayed: response.meta?.replayed === true };
    },
    // A lost slot race is an ordinary outcome on this path, not a transport
    // fault; retrying would only lose the same race again a moment later.
    retry: false,
    onSuccess: ({ created, replayed }) => {
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'appointments'],
      });
      // A booking creates or touches a customer record, and their counters move
      // with it, so the address book is stale too.
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'customers'],
      });

      toast({
        tone: 'success',
        title: replayed ? 'This booking was already recorded' : 'Appointment booked',
        description: replayed
          ? 'The same request had already gone through, so nothing was booked twice.'
          : created.appointment.requiresApproval && created.appointment.status === 'PENDING'
            ? 'It is waiting for approval, so the customer has not been told it is confirmed.'
            : `${formatDateLong(created.appointment.startsAt, activeTimezone)} at ${formatTime(
                created.appointment.startsAt,
                activeTimezone,
              )}.`,
      });

      onBooked?.(created.appointment);
      onClose();
    },
    onError: (error) => handleFailure(error),
  });

  /**
   * Turns a refusal into something the form can act on.
   *
   * The common failure on this endpoint is a slot somebody else took between the
   * search and the submit. That is not an error to dismiss — the receptionist is
   * still on the telephone — so the chosen time is dropped, the picker is re-read
   * from the server, and everything else they have typed is kept.
   *
   * It is matched on the three codes that actually mean the time is gone rather
   * than on the 409 status, because the other 409s this path can produce mean
   * something quite different: `IDEMPOTENCY_KEY_REUSED` is a client bug and
   * `IDEMPOTENCY_IN_PROGRESS` means the identical booking is being processed
   * right now. Throwing away the chosen time for either would tell the operator
   * to re-pick a slot that was never the problem.
   */
  function handleFailure(error: unknown): void {
    if (!isApiError(error)) {
      setFormError('Something went wrong. Please try again.');
      return;
    }

    if (
      error.code === 'SLOT_UNAVAILABLE' ||
      error.code === 'RESOURCE_UNAVAILABLE' ||
      error.code === 'CAPACITY_EXCEEDED'
    ) {
      setStartsAt(null);
      setErrors((current) => ({ ...current, startsAt: undefined }));
      // `SlotPicker` owns its own query, so the refetch is addressed by its key
      // prefix rather than through a handle this drawer does not hold.
      void queryClient.invalidateQueries({ queryKey: ['availability', 'slots'] });
      setFormError(
        error.code === 'SLOT_UNAVAILABLE'
          ? 'That time was taken while you were filling this in. The times below have been re-read — pick another one.'
          : `${error.message} The times below have been re-read.`,
      );
      return;
    }

    const fieldErrors: Partial<Record<FieldKey, string>> = {};
    let matched = false;
    for (const [path, message] of Object.entries(error.fieldErrors)) {
      const key = SERVER_FIELD_MAP[path];
      if (key === undefined) continue;
      fieldErrors[key] = message;
      matched = true;
    }
    setErrors(fieldErrors);
    setFormError(matched ? null : error.message);
  }

  /**
   * Local checks, run on submit only.
   *
   * Everything here is something the server also enforces; this exists so the
   * obvious omissions are caught without a round trip, not as a second source of
   * truth. Anything it disagrees with the API about, the API wins.
   */
  function validate(): CreateAppointmentBody | null {
    const next: Partial<Record<FieldKey, string>> = {};

    if (serviceId === '') next.serviceId = 'Choose the service being booked.';
    if (staffProfileId === '') next.staffProfileId = 'Choose who is delivering it.';
    if (startsAt === null) next.startsAt = 'Choose one of the times offered below.';

    let customer: CreateAppointmentBody['customer'] | null = null;

    if (mode === 'existing') {
      if (chosenCustomer === null) {
        next.customerId = 'Find and choose the customer, or switch to Someone new.';
      } else if (chosenCustomer.email === null || chosenCustomer.email === '') {
        // The booking body requires an address whichever path it came through:
        // it is what the confirmation is sent to, and part of what the server
        // hashes for idempotency.
        next.email = `${customerName(chosenCustomer)} has no email address on file, so they cannot be booked from here. Add one on their record first.`;
      } else {
        customer = {
          id: chosenCustomer.id,
          firstName: chosenCustomer.firstName,
          ...(chosenCustomer.lastName === null ? {} : { lastName: chosenCustomer.lastName }),
          email: chosenCustomer.email,
          ...(chosenCustomer.phone === null ? {} : { phone: chosenCustomer.phone }),
        };
      }
    } else {
      const firstName = draft.firstName.trim();
      const email = draft.email.trim();
      if (firstName === '') next.firstName = 'A first name is required.';
      if (email === '') next.email = 'An email address is required for the confirmation.';
      else if (!EMAIL_PATTERN.test(email)) next.email = 'Enter a valid email address.';

      if (firstName !== '' && email !== '' && EMAIL_PATTERN.test(email)) {
        customer = {
          firstName,
          ...(draft.lastName.trim() === '' ? {} : { lastName: draft.lastName.trim() }),
          email,
          ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
        };
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0 || customer === null || startsAt === null) return null;

    return {
      serviceId,
      staffProfileId,
      startsAt,
      // The same zone the availability search ran in. The horizon is a
      // calendar-day rule, so confirming in a different zone from the one the
      // search used can put the booking a day the other side of the limit.
      timezone: activeTimezone,
      customer,
      ...(notes.trim() === '' ? {} : { customerNotes: notes.trim() }),
    };
  }

  const serviceOptions = services.items
    .filter((row) => row.isActive)
    .map((row) => ({ value: row.id, label: row.name }));

  const providerOptions = staff.items
    .filter((row) => row.isBookable)
    .map((row) => ({ value: row.id, label: row.displayName }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Book an appointment"
      description="For a booking taken over the telephone or at the desk. Only times the scheduling engine can actually fill are offered."
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={book.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={book.isPending}
            leadingIcon={<CalendarPlus className="size-4" aria-hidden="true" />}
          >
            {startsAt === null
              ? 'Book appointment'
              : `Book ${formatTime(startsAt, activeTimezone)}`}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          const payload = validate();
          if (payload !== null) book.mutate(payload);
        }}
      >
        <FormBanner message={formError} />

        {/* --- What and who delivers it ------------------------------------ */}
        <section className="flex flex-col gap-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            What is being booked
          </h3>

          <Field
            label="Service"
            required
            error={errors.serviceId}
            hint={
              service
                ? `${formatDuration(service.durationMinutes)} · ${formatMoney(
                    service.priceAmount,
                    service.currency,
                  )}${service.requiresApproval ? ' · needs approval before it is confirmed' : ''}`
                : undefined
            }
          >
            {(field) => (
              /*
               * Disabled while the catalogue loads rather than swapped for a
               * skeleton: a skeleton in this slot would leave the `<label>`
               * pointing at an element that does not exist, so the field would
               * be unlabelled for exactly as long as it is unusable.
               */
              <Select
                {...field}
                value={serviceId}
                disabled={services.isLoading}
                placeholder={
                  services.isLoading
                    ? 'Loading services'
                    : serviceOptions.length === 0
                      ? 'No active service'
                      : 'Choose a service'
                }
                options={serviceOptions}
                onChange={(event) => {
                  setServiceId(event.target.value);
                  // The slot was offered for the previous service's duration and
                  // buffers, so it says nothing about this one.
                  setStartsAt(null);
                }}
              />
            )}
          </Field>

          <Field
            label="Provider"
            required
            error={errors.staffProfileId}
            hint="The API requires a named provider for a booking made from this side: staff-side booking is deliberate assignment rather than automatic matching."
          >
            {(field) => (
              <Select
                {...field}
                value={staffProfileId}
                disabled={staff.isLoading}
                placeholder={
                  staff.isLoading
                    ? 'Loading providers'
                    : providerOptions.length === 0
                      ? 'Nobody is bookable'
                      : 'Choose a provider'
                }
                options={providerOptions}
                onChange={(event) => {
                  setStaffProfileId(event.target.value);
                  setStartsAt(null);
                }}
              />
            )}
          </Field>

          {/*
           * Read-only, and only once a provider is named. The site is resolved
           * from their profile by the availability search and again by the
           * booking, so it is reported rather than chosen — see the file header.
           */}
          {provider ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
              <Info className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
              <span>
                {providerLocation
                  ? `This will be booked at ${providerLocation.name}, ${provider.displayName}'s default location.`
                  : `${provider.displayName} has no default location, so this booking is recorded without one.`}
              </span>
            </p>
          ) : null}
        </section>

        {/* --- When -------------------------------------------------------- */}
        <section className="flex flex-col gap-3 border-t border-border pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">When</h3>
            <Badge>{activeTimezone.replace(/_/g, ' ')}</Badge>
          </div>

          {!canSearch ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-fg-muted">
              Your role cannot read availability, so no times can be offered here.
            </p>
          ) : serviceId === '' || staffProfileId === '' ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-fg-muted">
              Choose a service and a provider first — the times offered depend on both.
            </p>
          ) : (
            <SlotPicker
              serviceId={serviceId}
              staffProfileId={staffProfileId}
              timezone={activeTimezone}
              date={date}
              onDateChange={(next) => {
                setDate(next);
                setStartsAt(null);
              }}
              value={startsAt}
              onChange={setStartsAt}
              disabled={book.isPending}
            />
          )}

          {errors.startsAt ? (
            <p className="text-xs font-medium text-danger-text" aria-live="polite">
              {errors.startsAt}
            </p>
          ) : null}
        </section>

        {/* --- Who it is for ----------------------------------------------- */}
        <section className="flex flex-col gap-4 border-t border-border pt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Who it is for
          </h3>

          {canPickCustomer ? (
            <Tabs
              label="How to identify the customer"
              value={mode}
              onValueChange={(next) => {
                setMode(next);
                setErrors({});
              }}
              items={[
                { value: 'existing', label: 'Existing customer' },
                { value: 'new', label: 'Someone new' },
              ]}
            />
          ) : (
            <p className="text-sm leading-relaxed text-fg-muted">
              Your role cannot read the address book, so the customer is identified by their
              details. An address already on file is matched rather than duplicated.
            </p>
          )}

          {mode === 'existing' && canPickCustomer ? (
            <>
              <SearchField
                label="Find the customer"
                value={customerSearch}
                placeholder="Name or email"
                onChange={setCustomerSearch}
                className="max-w-none"
              />

              <Field label="Customer" required error={errors.customerId ?? errors.email}>
                {(field) => (
                  <Select
                    {...field}
                    value={customerId}
                    disabled={customersQuery.isPending}
                    placeholder={
                      customersQuery.isPending
                        ? 'Searching'
                        : customers.length === 0
                          ? 'No customer matches'
                          : 'Choose a customer'
                    }
                    options={customers.map((row) => ({
                      value: row.id,
                      label: `${customerName(row)} — ${row.email ?? 'no email on file'}`,
                    }))}
                    onChange={(event) => setCustomerId(event.target.value)}
                  />
                )}
              </Field>

              {chosenCustomer?.status === 'BLOCKED' ? (
                <p className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text">
                  This customer is blocked, so the API will refuse the booking. Change their status
                  on their record if that is no longer right.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" required error={errors.firstName}>
                  {(field) => (
                    <Input
                      {...field}
                      value={draft.firstName}
                      autoComplete="given-name"
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, firstName: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label="Last name">
                  {(field) => (
                    <Input
                      {...field}
                      value={draft.lastName}
                      autoComplete="family-name"
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, lastName: event.target.value }))
                      }
                    />
                  )}
                </Field>
              </div>

              <Field
                label="Email"
                required
                error={errors.email}
                hint="The confirmation goes here. An address already on file is matched to that customer rather than creating a second record for them."
              >
                {(field) => (
                  <Input
                    {...field}
                    type="email"
                    value={draft.email}
                    autoComplete="email"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, email: event.target.value }))
                    }
                  />
                )}
              </Field>

              <Field label="Phone" error={errors.phone}>
                {(field) => (
                  <Input
                    {...field}
                    type="tel"
                    value={draft.phone}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, phone: event.target.value }))
                    }
                  />
                )}
              </Field>
            </>
          )}

          <Field
            label="Note from the customer"
            hint="Anything they asked for. This is the customer-facing note, not a private one — the private note is added on the appointment afterwards."
          >
            {(field) => (
              <Textarea
                {...field}
                rows={3}
                value={notes}
                maxLength={5000}
                onChange={(event) => setNotes(event.target.value)}
              />
            )}
          </Field>
        </section>
      </form>
    </Drawer>
  );
}
