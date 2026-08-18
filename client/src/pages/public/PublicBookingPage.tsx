/**
 * The public booking flow.
 *
 * This is the page a business's own customers see, so it is held to a higher
 * bar than the internal screens: it must work on a phone, on a keyboard, in the
 * visitor's own timezone, and it must never take someone through six steps and
 * then lose their booking to a race.
 *
 * Three decisions are load-bearing:
 *
 *  - **One idempotency key per booking attempt.** Generated when the flow
 *    starts and sent on every confirm, so a double-tap, a retry after a dropped
 *    connection, or an impatient refresh all resolve to a single appointment.
 *  - **A lost race keeps the visitor's work.** A 409 refreshes availability and
 *    returns them to the time step with every detail they typed intact.
 *  - **The provider is only ever named when the link permits it.** A link with
 *    `allowStaffSelection: false` answers 422 to a `staffProfileId`, so sending
 *    one "just to be explicit" would make such links unbookable outright.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  Clock,
  MapPin,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  buttonStyles,
  Card,
  CardBody,
  Checkbox,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { isApiError } from '@/lib/apiClient';
import { browserTimezone, formatDuration, formatMoney } from '@/lib/format';
import type { PublicService, PublicSlot } from '@/types/api';
import { PublicShell, Stepper } from './PublicShell';
import { SlotPicker } from './SlotPicker';
import { BookingSummary } from './BookingSummary';
import { QuestionField, validateAnswer } from './QuestionField';
import {
  rememberBookingLink,
  useAvailability,
  useBookingLink,
  useCreateBooking,
  type AnswerValue,
} from './publicApi';

/** How many days of availability are fetched and shown at a time. */
const WINDOW_DAYS = 7;

type StepId = 'service' | 'provider' | 'time' | 'details' | 'policy' | 'review';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CustomerDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
}

const EMPTY_CUSTOMER: CustomerDraft = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  notes: '',
};

export default function PublicBookingPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const linkQuery = useBookingLink(slug);

  const [timezone, setTimezone] = useState(browserTimezone);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffProfileId, setStaffProfileId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<PublicSlot | null>(null);
  const [customer, setCustomer] = useState<CustomerDraft>(EMPTY_CUSTOMER);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [consent, setConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [windowStart, setWindowStart] = useState(() =>
    DateTime.now().setZone(browserTimezone()).toFormat('yyyy-MM-dd'),
  );
  const [step, setStep] = useState<StepId>('service');
  const [raceMessage, setRaceMessage] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);

  // One key for this booking attempt. Replaced only when the visitor is sent
  // back to choose a different time, because that is a genuinely new booking.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const headingRef = useRef<HTMLHeadingElement>(null);

  const link = linkQuery.data;
  const services = useMemo(() => link?.services ?? [], [link]);
  const staff = useMemo(() => link?.staff ?? [], [link]);
  const locations = useMemo(() => link?.locations ?? [], [link]);
  const questions = useMemo(() => link?.questions ?? [], [link]);
  const policy = link?.policy;
  const allowStaffSelection = link?.link.allowStaffSelection ?? false;

  const service = useMemo<PublicService | null>(
    () => services.find((item) => item.id === serviceId) ?? null,
    [services, serviceId],
  );

  const canChooseStaff = allowStaffSelection && staff.length > 1;
  const canChooseLocation = locations.length > 1;

  const steps = useMemo(() => {
    const list: Array<{ id: StepId; label: string }> = [];
    if (services.length > 1) list.push({ id: 'service', label: 'Service' });
    if (canChooseStaff || canChooseLocation) list.push({ id: 'provider', label: 'Where & who' });
    list.push(
      { id: 'time', label: 'Time' },
      { id: 'details', label: 'Details' },
      { id: 'policy', label: 'Policy' },
      { id: 'review', label: 'Review' },
    );
    return list;
  }, [services.length, canChooseStaff, canChooseLocation]);

  // A link offering exactly one service has nothing to ask on the first step.
  useEffect(() => {
    if (!link || serviceId || services.length !== 1) return;
    setServiceId(services[0]!.id);
    setStep(steps[0]!.id);
  }, [link, serviceId, services, steps]);

  const todayIso = useMemo(
    () => DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd'),
    [timezone],
  );

  // Changing the timezone can move "today" across a date line; clamping here
  // avoids an effect that would fight the visitor's own window paging.
  const effectiveStart = windowStart < todayIso ? todayIso : windowStart;

  const windowEnd = useMemo(
    () =>
      DateTime.fromISO(effectiveStart, { zone: timezone })
        .plus({ days: WINDOW_DAYS - 1 })
        .toFormat('yyyy-MM-dd'),
    [effectiveStart, timezone],
  );

  const availabilityQuery = useAvailability(
    slug,
    {
      serviceId,
      // Never sent unless the link publishes a provider choice.
      staffProfileId: allowStaffSelection ? staffProfileId : null,
      locationId,
      fromDate: effectiveStart,
      toDate: windowEnd,
      timezone,
    },
    step === 'time' || step === 'review',
  );

  const effectiveService = availabilityQuery.data?.service;

  const horizonEnd = useMemo(() => {
    const days = effectiveService?.maxHorizonDays ?? policy?.maxHorizonDays;
    if (days === undefined) return null;
    return DateTime.now().setZone(timezone).plus({ days }).toFormat('yyyy-MM-dd');
  }, [effectiveService?.maxHorizonDays, policy?.maxHorizonDays, timezone]);

  const bookingMutation = useCreateBooking(slug, idempotencyKey);
  const confirmation = bookingMutation.data;

  const currentIndex = Math.max(
    0,
    steps.findIndex((item) => item.id === step),
  );

  const goTo = useCallback((next: StepId) => {
    setStep(next);
    setFieldErrors({});
    // Move focus to the new step's heading, otherwise a keyboard or screen
    // reader user is left where the previous step's controls used to be.
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, []);

  const goBack = useCallback(() => {
    const previous = steps[currentIndex - 1];
    if (previous) goTo(previous.id);
  }, [steps, currentIndex, goTo]);

  const goForward = useCallback(() => {
    const next = steps[currentIndex + 1];
    if (next) goTo(next.id);
  }, [steps, currentIndex, goTo]);

  const shiftWindow = useCallback(
    (direction: -1 | 1) => {
      setWindowStart((current) =>
        DateTime.fromISO(current < todayIso ? todayIso : current, { zone: timezone })
          .plus({ days: direction * WINDOW_DAYS })
          .toFormat('yyyy-MM-dd'),
      );
    },
    [todayIso, timezone],
  );

  function validateDetails(): boolean {
    const errors: Record<string, string> = {};
    if (!customer.firstName.trim()) errors.firstName = 'Please enter your first name.';
    if (!customer.email.trim()) errors.email = 'Please enter your email address.';
    else if (!EMAIL_PATTERN.test(customer.email.trim()))
      errors.email = 'Enter a valid email address.';

    for (const question of questions) {
      const problem = validateAnswer(question, answers[question.key]);
      if (problem) errors[`answers.${question.key}`] = problem;
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function confirm() {
    if (!service || !selectedSlot) return;
    setRaceMessage(null);

    try {
      const result = await bookingMutation.mutateAsync({
        serviceId: service.id,
        // The slot names the provider it belongs to, which is who the visitor
        // gets whether or not they expressed a preference — but the field may
        // only be sent at all when the link publishes a choice.
        ...(allowStaffSelection ? { staffProfileId: selectedSlot.staffProfileId } : {}),
        ...(selectedSlot.locationId ? { locationId: selectedSlot.locationId } : {}),
        startsAt: selectedSlot.startsAt,
        timezone,
        customer: {
          firstName: customer.firstName.trim(),
          ...(customer.lastName.trim() ? { lastName: customer.lastName.trim() } : {}),
          email: customer.email.trim(),
          ...(customer.phone.trim() ? { phone: customer.phone.trim() } : {}),
        },
        ...(customer.notes.trim() ? { customerNotes: customer.notes.trim() } : {}),
        ...(Object.keys(answers).length > 0 ? { answers } : {}),
      });

      // Availability is published per link, so the manage page can only offer a
      // slot grid if it knows which link this booking came through.
      rememberBookingLink(result.appointment.publicId, slug);
      setIsDone(true);
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        // Somebody else took it while this visitor was filling in the form.
        // Everything they typed is kept; only the time has to change.
        setRaceMessage(
          error.code === 'SLOT_UNAVAILABLE'
            ? 'Sorry — that time was taken while you were booking. Your details are saved; please pick another time.'
            : `${error.message} Your details are saved; please pick another time.`,
        );
        setSelectedSlot(null);
        // A different slot is a different booking, so it gets its own key.
        setIdempotencyKey(crypto.randomUUID());
        void availabilityQuery.refetch();
        goTo('time');
        return;
      }
      if (isApiError(error) && error.isValidation) {
        setFieldErrors(error.fieldErrors);
        goTo('details');
        return;
      }
      // Anything else is surfaced in place by the mutation's own error banner.
    }
  }

  if (linkQuery.isLoading) {
    return (
      <PublicShell business={null}>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </PublicShell>
    );
  }

  if (linkQuery.isError || !link) {
    return (
      <PublicShell business={null}>
        <ErrorState
          error={linkQuery.error}
          title="This booking page is not available"
          onRetry={() => void linkQuery.refetch()}
        />
      </PublicShell>
    );
  }

  const accent =
    typeof link.link.branding?.primaryColor === 'string' ? link.link.branding.primaryColor : null;

  const chosenLocation = selectedSlot
    ? (locations.find((place) => place.id === selectedSlot.locationId) ?? null)
    : null;

  const customerName = `${customer.firstName} ${customer.lastName}`.trim();

  const headingText = isDone
    ? confirmation?.appointment.requiresApproval
      ? 'Request sent'
      : 'You are booked'
    : step === 'service'
      ? link.link.name
      : step === 'provider'
        ? 'Where and who'
        : step === 'time'
          ? 'Pick a time'
          : step === 'details'
            ? 'Your details'
            : step === 'policy'
              ? 'Before you book'
              : 'Review and confirm';

  return (
    <PublicShell
      business={link.business}
      accentColor={accent}
      timezone={timezone}
      onTimezoneChange={setTimezone}
    >
      {!isDone ? (
        <Stepper
          steps={steps}
          currentIndex={currentIndex}
          onStepSelect={(index) => goTo(steps[index]!.id)}
        />
      ) : null}

      {raceMessage ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning-text"
        >
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {raceMessage}
        </div>
      ) : null}

      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mb-1 text-xl font-semibold tracking-tight outline-none sm:text-2xl"
      >
        {headingText}
      </h1>
      {!isDone && step === 'service' && link.link.description ? (
        <p className="mb-5 text-sm text-fg-secondary">{link.link.description}</p>
      ) : (
        <div className="mb-5" />
      )}

      {/* ------------------------------------------------------ Service --- */}
      {!isDone && step === 'service' ? (
        services.length === 0 ? (
          <EmptyState
            icon={<Clock aria-hidden className="h-6 w-6" />}
            title="Nothing is bookable here yet"
            description={`${link.business.name} has not published any services on this page.`}
            action={
              link.business.supportEmail ? (
                <a
                  href={`mailto:${link.business.supportEmail}`}
                  className={buttonStyles('primary', 'md')}
                >
                  Contact {link.business.name}
                </a>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {services.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id !== serviceId) {
                    setServiceId(item.id);
                    // A different service has different openings entirely.
                    setSelectedSlot(null);
                  }
                  goForward();
                }}
                className={cn(
                  'w-full rounded-xl border border-border bg-surface p-4 text-left transition-colors',
                  'hover:border-brand hover:bg-surface-hover',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium">{item.name}</p>
                    {item.description ? (
                      <p className="mt-1 text-sm text-fg-secondary">{item.description}</p>
                    ) : null}
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                      <span className="inline-flex items-center gap-1">
                        <Clock aria-hidden className="h-4 w-4" />
                        {formatDuration(item.durationMinutes)}
                      </span>
                      {item.capacity > 1 ? (
                        <Badge tone="info">Group · up to {item.capacity}</Badge>
                      ) : null}
                      {item.requiresApproval ? <Badge tone="warning">Needs approval</Badge> : null}
                    </span>
                  </div>
                  <p className="shrink-0 font-medium">
                    {formatMoney(item.priceAmount, item.currency)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : null}

      {/* ----------------------------------------------------- Provider --- */}
      {!isDone && step === 'provider' ? (
        <div className="space-y-6">
          {canChooseStaff ? (
            <div>
              <h2 className="mb-2 text-sm font-medium text-fg-secondary">Provider</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceCard
                  selected={staffProfileId === null}
                  onSelect={() => {
                    setStaffProfileId(null);
                    setSelectedSlot(null);
                  }}
                  title="No preference"
                  subtitle="We will match you with the best available provider"
                  icon={<Users aria-hidden className="h-4 w-4" />}
                />
                {staff.map((member) => (
                  <ChoiceCard
                    key={member.id}
                    selected={staffProfileId === member.id}
                    onSelect={() => {
                      setStaffProfileId(member.id);
                      setSelectedSlot(null);
                    }}
                    title={member.displayName}
                    icon={<UserRound aria-hidden className="h-4 w-4" />}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {canChooseLocation ? (
            <div>
              <h2 className="mb-2 text-sm font-medium text-fg-secondary">Location</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceCard
                  selected={locationId === null}
                  onSelect={() => {
                    setLocationId(null);
                    setSelectedSlot(null);
                  }}
                  title="Any location"
                  subtitle="Show times at every site"
                  icon={<MapPin aria-hidden className="h-4 w-4" />}
                />
                {locations.map((place) => (
                  <ChoiceCard
                    key={place.id}
                    selected={locationId === place.id}
                    onSelect={() => {
                      setLocationId(place.id);
                      setSelectedSlot(null);
                    }}
                    title={place.name}
                    subtitle={place.address ?? undefined}
                    icon={<MapPin aria-hidden className="h-4 w-4" />}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <StepNav
            onBack={currentIndex > 0 ? goBack : undefined}
            next={<Button onClick={goForward}>Continue</Button>}
          />
        </div>
      ) : null}

      {/* --------------------------------------------------------- Time --- */}
      {!isDone && step === 'time' ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Jump to a date" className="w-full sm:w-56">
              {(props) => (
                <DatePicker
                  {...props}
                  value={effectiveStart}
                  timezone={timezone}
                  min={todayIso}
                  max={horizonEnd ?? undefined}
                  onChange={setWindowStart}
                />
              )}
            </Field>
            {effectiveService ? (
              <p className="pb-2 text-xs text-fg-muted">
                {effectiveService.minNoticeMinutes > 0
                  ? `Bookings need at least ${formatDuration(effectiveService.minNoticeMinutes)} notice.`
                  : null}
              </p>
            ) : null}
          </div>

          <SlotPicker
            slots={availabilityQuery.data?.slots ?? []}
            timezone={timezone}
            isLoading={availabilityQuery.isFetching}
            error={availabilityQuery.isError ? availabilityQuery.error : null}
            onRetry={() => void availabilityQuery.refetch()}
            selectedStartsAt={selectedSlot?.startsAt ?? null}
            onSelect={(slot) => {
              setSelectedSlot(slot);
              setRaceMessage(null);
              // Clear the previous attempt's failure, or returning to Review
              // would show an error banner about a slot no longer in play.
              bookingMutation.reset();
              goForward();
            }}
            fromDate={effectiveStart}
            toDate={windowEnd}
            onShiftWindow={shiftWindow}
            canGoBack={effectiveStart > todayIso}
            canGoForward={horizonEnd === null || windowEnd < horizonEnd}
            truncated={availabilityQuery.data?.truncated ?? false}
            showProvider={allowStaffSelection && staffProfileId === null && staff.length > 1}
          />

          <StepNav onBack={currentIndex > 0 ? goBack : undefined} />
        </div>
      ) : null}

      {/* ------------------------------------------------------ Details --- */}
      {!isDone && step === 'details' ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (validateDetails()) goForward();
          }}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required error={fieldErrors.firstName}>
              {(props) => (
                <Input
                  {...props}
                  value={customer.firstName}
                  autoComplete="given-name"
                  onChange={(event) =>
                    setCustomer((current) => ({ ...current, firstName: event.target.value }))
                  }
                />
              )}
            </Field>
            <Field label="Last name" error={fieldErrors.lastName}>
              {(props) => (
                <Input
                  {...props}
                  value={customer.lastName}
                  autoComplete="family-name"
                  onChange={(event) =>
                    setCustomer((current) => ({ ...current, lastName: event.target.value }))
                  }
                />
              )}
            </Field>
          </div>

          <Field
            label="Email"
            required
            hint="Your confirmation and any reminders go here."
            error={fieldErrors.email}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                inputMode="email"
                value={customer.email}
                autoComplete="email"
                onChange={(event) =>
                  setCustomer((current) => ({ ...current, email: event.target.value }))
                }
              />
            )}
          </Field>

          <Field label="Phone" error={fieldErrors.phone}>
            {(props) => (
              <Input
                {...props}
                type="tel"
                inputMode="tel"
                value={customer.phone}
                autoComplete="tel"
                onChange={(event) =>
                  setCustomer((current) => ({ ...current, phone: event.target.value }))
                }
              />
            )}
          </Field>

          {questions.map((question) => (
            <QuestionField
              key={question.key}
              question={question}
              value={answers[question.key]}
              error={fieldErrors[`answers.${question.key}`]}
              timezone={timezone}
              onChange={(value) => setAnswers((current) => ({ ...current, [question.key]: value }))}
            />
          ))}

          <Field label="Anything we should know?" hint="Optional">
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                value={customer.notes}
                onChange={(event) =>
                  setCustomer((current) => ({ ...current, notes: event.target.value }))
                }
              />
            )}
          </Field>

          <StepNav onBack={goBack} next={<Button type="submit">Continue</Button>} />
        </form>
      ) : null}

      {/* ------------------------------------------------------- Policy --- */}
      {!isDone && step === 'policy' && policy ? (
        <div className="space-y-5">
          <Card>
            <CardBody className="space-y-3 text-sm text-fg-secondary">
              <p className="flex items-center gap-2 font-medium text-fg">
                <ShieldCheck aria-hidden className="h-4 w-4" />
                {link.business.name}&rsquo;s booking policy
              </p>
              <ul className="list-inside list-disc space-y-1.5">
                {policy.allowCustomerCancel ? (
                  <li>
                    You can cancel online up to {formatDuration(policy.cancellationDeadlineMinutes)}{' '}
                    before the appointment.
                  </li>
                ) : (
                  <li>Cancellations must be arranged with the business directly.</li>
                )}
                {policy.allowCustomerReschedule ? (
                  <li>
                    You can reschedule online up to{' '}
                    {formatDuration(policy.rescheduleDeadlineMinutes)} before the appointment, up to{' '}
                    {policy.maxReschedulesPerAppointment} time
                    {policy.maxReschedulesPerAppointment === 1 ? '' : 's'}.
                  </li>
                ) : (
                  <li>Changes of time must be arranged with the business directly.</li>
                )}
                {policy.minNoticeMinutes > 0 ? (
                  <li>Bookings need at least {formatDuration(policy.minNoticeMinutes)} notice.</li>
                ) : null}
                {service?.requiresApproval ? (
                  <li>This is a request: {link.business.name} confirms it before it is booked.</li>
                ) : null}
              </ul>
              {link.business.supportEmail || link.business.supportPhone ? (
                <p>
                  Questions?{' '}
                  {link.business.supportEmail ? (
                    <a
                      className="text-brand-text underline underline-offset-2"
                      href={`mailto:${link.business.supportEmail}`}
                    >
                      {link.business.supportEmail}
                    </a>
                  ) : null}
                  {link.business.supportEmail && link.business.supportPhone ? ' · ' : null}
                  {link.business.supportPhone ? (
                    <a
                      className="text-brand-text underline underline-offset-2"
                      href={`tel:${link.business.supportPhone}`}
                    >
                      {link.business.supportPhone}
                    </a>
                  ) : null}
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Checkbox
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked);
              if (event.target.checked) setFieldErrors({});
            }}
            label={`I agree to ${link.business.name}'s booking policy and to being contacted about this appointment.`}
            error={fieldErrors.consent}
          />

          <StepNav
            onBack={goBack}
            next={
              <Button
                onClick={() => {
                  if (!consent) {
                    setFieldErrors({ consent: 'Please agree to the policy to continue.' });
                    return;
                  }
                  goForward();
                }}
              >
                Continue
              </Button>
            }
          />
        </div>
      ) : null}

      {/* ------------------------------------------------------- Review --- */}
      {!isDone && step === 'review' ? (
        service && selectedSlot ? (
          <div className="space-y-5">
            <BookingSummary
              serviceName={service.name}
              slot={selectedSlot}
              timezone={timezone}
              locationName={chosenLocation?.name ?? null}
              locationAddress={chosenLocation?.address ?? null}
              customerName={customerName}
              customerEmail={customer.email.trim()}
              customerPhone={customer.phone.trim() || null}
              notes={customer.notes.trim() || null}
              questions={questions}
              answers={answers}
            />

            {service.requiresApproval ? (
              <p className="rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
                This is a request. {link.business.name} will confirm it before it is booked.
              </p>
            ) : null}

            <p aria-live="polite" className="mf-sr-only">
              {bookingMutation.isPending ? 'Confirming your booking' : ''}
            </p>

            {bookingMutation.isError && !raceMessage ? (
              <div
                role="alert"
                className="rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
              >
                {isApiError(bookingMutation.error)
                  ? bookingMutation.error.message
                  : 'We could not complete your booking. Please try again.'}
              </div>
            ) : null}

            <StepNav
              onBack={goBack}
              backDisabled={bookingMutation.isPending}
              next={
                <Button
                  onClick={() => void confirm()}
                  loading={bookingMutation.isPending}
                  leadingIcon={<CalendarCheck2 aria-hidden className="h-4 w-4" />}
                >
                  {service.requiresApproval ? 'Send request' : 'Confirm booking'}
                </Button>
              }
            />
          </div>
        ) : (
          <EmptyState
            icon={<Clock aria-hidden className="h-6 w-6" />}
            title="Your time slot is no longer held"
            description="Choose a time again to carry on — the details you entered are kept."
            action={<Button onClick={() => goTo('time')}>Pick a time</Button>}
          />
        )
      ) : null}

      {/* ------------------------------------------------------ Success --- */}
      {isDone && confirmation && service && selectedSlot ? (
        <div className="space-y-5">
          <div
            role="status"
            className="flex items-start gap-3 rounded-xl border border-success-border bg-success-subtle p-4 text-success-text"
          >
            <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">
                {confirmation.appointment.requiresApproval
                  ? 'Your request has been sent'
                  : 'Your appointment is confirmed'}
              </p>
              <p className="text-sm">
                We have emailed the details to {customer.email.trim()}.
                {confirmation.appointment.requiresApproval
                  ? ' You will hear from us once it has been reviewed.'
                  : ''}
              </p>
            </div>
          </div>

          <BookingSummary
            serviceName={service.name}
            slot={selectedSlot}
            timezone={timezone}
            locationName={chosenLocation?.name ?? null}
            locationAddress={chosenLocation?.address ?? null}
            customerName={customerName}
            customerEmail={customer.email.trim()}
            customerPhone={customer.phone.trim() || null}
            notes={customer.notes.trim() || null}
            questions={questions}
            answers={answers}
          />

          <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
            Your reference is{' '}
            <span className="font-mono font-medium text-fg">
              {confirmation.appointment.publicId}
            </span>
          </div>

          {/* The slug rides along so the manage page can show a real slot grid
              even where localStorage is unavailable. */}
          <Link
            to={`/appointments/${confirmation.appointment.publicId}?link=${encodeURIComponent(slug)}`}
            className={buttonStyles('primary', 'md')}
          >
            View or change this booking
          </Link>
        </div>
      ) : null}
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StepNav({
  onBack,
  backDisabled = false,
  next,
}: {
  onBack?: () => void;
  backDisabled?: boolean;
  next?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack} disabled={backDisabled}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {next ?? <span />}
    </div>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  title,
  subtitle,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected
          ? 'border-brand bg-brand-subtle'
          : 'border-border bg-surface hover:bg-surface-hover',
      )}
    >
      {icon ? <span className="mt-0.5 text-fg-muted">{icon}</span> : null}
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        {subtitle ? <span className="mt-0.5 block text-sm text-fg-muted">{subtitle}</span> : null}
      </span>
    </button>
  );
}
