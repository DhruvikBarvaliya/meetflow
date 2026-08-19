/**
 * Test data, built through the real API.
 *
 * Fixtures are created by calling the same endpoints a real client calls rather
 * than by seeding the database, so a spec can never pass against a state the
 * application itself could not produce — and a change that breaks workspace
 * setup breaks these fixtures loudly instead of leaving the specs green.
 *
 * Two rules hold throughout:
 *
 *  - **Every run mints its own identities.** Emails, workspace names and service
 *    names all carry a timestamp and a counter, so two workers, two retries and
 *    two consecutive local runs never collide.
 *  - **No identifier is ever hard-coded.** Ids come back from the call that
 *    created the record; a spec that asserted on a literal uuid would be
 *    asserting on the seed data rather than on the product.
 */
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:4000';

/** Satisfies the server policy: 10+ chars, upper, lower, digit, not breached. */
export const TEST_PASSWORD = 'Str0ngPass!2026';

export const TEST_TIMEZONE = 'Asia/Kolkata';

let counter = 0;

/** Unique per run *and* per call, so parallel workers cannot collide. */
export function uniqueEmail(prefix = 'e2e'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 7)}@meetflow.test`;
}

export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now().toString(36)}${counter}`;
}

/** A workspace address: lowercase, digits and single hyphens only. */
export function uniqueSlug(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface ApiOptions {
  method?: string;
  token?: string;
  businessId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiCallError';
    this.status = status;
    this.code = code;
  }
}

/**
 * One call against the API, unwrapping the `{ data, meta }` envelope.
 *
 * A failure throws `ApiCallError` carrying the real status and error code, so a
 * spec can assert "this was refused with 404" rather than regex-matching a
 * message that is free to be reworded.
 */
export async function apiCall<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.businessId) headers['X-Business-Id'] = options.businessId;

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = text
    ? (JSON.parse(text) as { data?: T; error?: { message: string; code: string } })
    : null;

  if (!response.ok) {
    throw new ApiCallError(
      `${options.method ?? 'GET'} ${path} -> ${response.status} ` +
        `${payload?.error?.code ?? ''} ${payload?.error?.message ?? text}`,
      response.status,
      payload?.error?.code ?? 'UNKNOWN',
    );
  }
  return payload?.data as T;
}

/** The status a call was refused with, or 0 if it unexpectedly succeeded. */
export async function statusOf(call: Promise<unknown>): Promise<number> {
  try {
    await call;
    return 0;
  } catch (error) {
    return error instanceof ApiCallError ? error.status : -1;
  }
}

// ---------------------------------------------------------------------------
// Accounts and workspaces
// ---------------------------------------------------------------------------

export interface AccountFixture {
  email: string;
  password: string;
  token: string;
  userId: string;
}

/** A registered user with no workspace yet — the state onboarding starts from. */
export async function registerAccount(prefix = 'owner'): Promise<AccountFixture> {
  const email = uniqueEmail(prefix);
  const result = await apiCall<{ accessToken: string; user: { id: string } }>(
    '/api/v1/auth/register',
    {
      method: 'POST',
      body: {
        email,
        password: TEST_PASSWORD,
        firstName: 'E2E',
        lastName: 'Owner',
        timezone: TEST_TIMEZONE,
      },
    },
  );
  return { email, password: TEST_PASSWORD, token: result.accessToken, userId: result.user.id };
}

export interface OwnerFixture extends AccountFixture {
  businessId: string;
  businessName: string;
  staffProfileId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  locationId: string;
  bookingLinkId: string;
  bookingSlug: string;
  /** Where the booking page actually lives in the client router. */
  bookingPath: string;
}

/**
 * A workspace ready to take public bookings.
 *
 * Deliberately the whole chain — owner, location, service, staff, that staff
 * member's weekly hours, the service-to-staff assignment and a published link —
 * because a slot only exists when every one of those is in place. Dropping any
 * step yields an empty slot grid, which is the single most confusing way for a
 * booking spec to fail.
 */
export async function createBookableWorkspace(prefix = 'owner'): Promise<OwnerFixture> {
  const account = await registerAccount(prefix);
  const { token } = account;

  const businessName = uniqueName('E2E Studio');
  const workspace = await apiCall<{
    business: { id: string };
    staffProfile: { id: string; displayName: string } | null;
  }>('/api/v1/workspaces', {
    method: 'POST',
    token,
    body: {
      name: businessName,
      slug: uniqueSlug(prefix),
      timezone: TEST_TIMEZONE,
      currency: 'INR',
      createStaffProfile: true,
    },
  });

  const businessId = workspace.business.id;
  if (!workspace.staffProfile) {
    throw new Error('Workspace creation did not return the owner staff profile it was asked for.');
  }
  const staffProfile = workspace.staffProfile;
  const ctx = { token, businessId };

  const location = await apiCall<{ id: string }>('/api/v1/locations', {
    ...ctx,
    method: 'POST',
    body: { name: 'Main Studio', type: 'PHYSICAL', timezone: TEST_TIMEZONE, city: 'Bengaluru' },
  });

  const serviceName = uniqueName('Consultation');
  const service = await apiCall<{ id: string }>('/api/v1/services', {
    ...ctx,
    method: 'POST',
    body: {
      name: serviceName,
      durationMinutes: 30,
      priceAmount: 100_000,
      capacity: 1,
      slotIntervalMinutes: 30,
      // The workspace default is 60 minutes' notice; zero here keeps the whole
      // of tomorrow bookable so a spec never has to reason about "now".
      minNoticeMinutes: 0,
    },
  });

  await apiCall(`/api/v1/services/${service.id}/staff`, {
    ...ctx,
    method: 'PUT',
    body: { staffProfileIds: [staffProfile.id] },
  });

  // Mon–Sat 09:00–17:00. Six days rather than five so that whichever weekday a
  // spec runs on, the next few days always contain an opening.
  await apiCall(`/api/v1/availability/staff/${staffProfile.id}/rules`, {
    ...ctx,
    method: 'PUT',
    body: {
      rules: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '09:00',
        endTime: '17:00',
      })),
    },
  });

  const link = await apiCall<{ id: string; slug: string }>('/api/v1/booking-links', {
    ...ctx,
    method: 'POST',
    body: { name: `Book ${serviceName}`, type: 'SINGLE_SERVICE', serviceId: service.id },
  });

  return {
    ...account,
    businessId,
    businessName,
    staffProfileId: staffProfile.id,
    staffName: staffProfile.displayName,
    serviceId: service.id,
    serviceName,
    locationId: location.id,
    bookingLinkId: link.id,
    bookingSlug: link.slug,
    bookingPath: bookingPathFor(link.slug),
  };
}

/**
 * The client route a booking link is served from.
 *
 * Note that this is **not** the `publicUrl` the API reports for a link: that
 * value omits the `/b` segment. `tenancy.spec.ts` and `workspace.spec.ts` both
 * assert on the discrepancy rather than papering over it here.
 */
export function bookingPathFor(slug: string): string {
  return `/b/${slug}`;
}

// ---------------------------------------------------------------------------
// Public booking surface
// ---------------------------------------------------------------------------

export interface PublicSlot {
  startsAt: string;
  endsAt: string;
  staffProfileId: string;
  staffName: string;
  locationId: string | null;
  durationMinutes: number;
}

/**
 * The real shape of `POST /public/booking-links/:slug/bookings`.
 *
 * The appointment is *nested*, not spread across the top level. Typing it as a
 * flat `{ publicId }` is how an assertion ends up comparing `undefined` to
 * `undefined` and passing without testing anything.
 */
export interface PublicBookingConfirmation {
  appointment: {
    publicId: string;
    status: string;
    startsAt: string;
    endsAt: string;
    requiresApproval: boolean;
  };
  participantPublicId: string;
  manageUrl: string;
  /** True when an idempotency key replayed an earlier, identical request. */
  replayed: boolean;
}

export interface PublicAppointmentView {
  publicId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  rescheduleCount: number;
  cancellationReason: string | null;
  service: { id: string; name: string } | null;
  staff: { id: string; displayName: string } | null;
  business: { name: string };
  policy: {
    canCancel: boolean;
    canReschedule: boolean;
    remainingReschedules: number;
    cancellationDeadlineMinutes: number;
    rescheduleDeadlineMinutes: number;
  };
}

/** An ISO calendar date `daysAhead` from today, read in the test timezone. */
export function isoDateAhead(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

export async function fetchPublicSlots(
  slug: string,
  serviceId: string,
  options: { fromDaysAhead?: number; toDaysAhead?: number } = {},
): Promise<PublicSlot[]> {
  const fromDate = isoDateAhead(options.fromDaysAhead ?? 1);
  const toDate = isoDateAhead(options.toDaysAhead ?? 10);
  const result = await apiCall<{ slots: PublicSlot[] }>(
    `/api/v1/public/booking-links/${slug}/availability` +
      `?serviceId=${serviceId}&fromDate=${fromDate}&toDate=${toDate}&timezone=${encodeURIComponent(TEST_TIMEZONE)}`,
  );
  return result.slots;
}

/**
 * The first opening that starts at least `minHoursAhead` from now.
 *
 * The workspace booking policy refuses an online reschedule or cancellation
 * inside 24 hours, so a spec that needs those actions to be *available* has to
 * book beyond that deadline rather than take whatever comes first.
 */
export async function findSlot(
  slug: string,
  serviceId: string,
  options: { minHoursAhead?: number; skip?: number } = {},
): Promise<PublicSlot> {
  const minHoursAhead = options.minHoursAhead ?? 0;
  const skip = options.skip ?? 0;
  const cutoff = Date.now() + minHoursAhead * 3_600_000;

  const slots = await fetchPublicSlots(slug, serviceId);
  const eligible = slots.filter((slot) => new Date(slot.startsAt).getTime() > cutoff);

  const slot = eligible[skip];
  if (!slot) {
    throw new Error(
      `No opening at least ${minHoursAhead}h ahead (index ${skip}) on link ${slug}: ` +
        `${slots.length} slots returned, ${eligible.length} past the cutoff.`,
    );
  }
  return slot;
}

export function bookPublicSlot(
  slug: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<PublicBookingConfirmation> {
  return apiCall<PublicBookingConfirmation>(`/api/v1/public/booking-links/${slug}/bookings`, {
    method: 'POST',
    ...(idempotencyKey ? { headers: { 'X-Idempotency-Key': idempotencyKey } } : {}),
    body,
  });
}

/** Books a real opening and returns the confirmation, for specs whose subject is what happens next. */
export async function bookAppointment(
  workspace: OwnerFixture,
  options: {
    minHoursAhead?: number;
    skip?: number;
    customerEmail?: string;
    firstName?: string;
  } = {},
): Promise<{ confirmation: PublicBookingConfirmation; slot: PublicSlot; customerEmail: string }> {
  const slot = await findSlot(workspace.bookingSlug, workspace.serviceId, options);
  const customerEmail = options.customerEmail ?? uniqueEmail('customer');

  const confirmation = await bookPublicSlot(
    workspace.bookingSlug,
    {
      serviceId: workspace.serviceId,
      staffProfileId: slot.staffProfileId,
      startsAt: slot.startsAt,
      timezone: TEST_TIMEZONE,
      customer: {
        firstName: options.firstName ?? 'Booked',
        lastName: 'ByApi',
        email: customerEmail,
      },
    },
    crypto.randomUUID(),
  );

  return { confirmation, slot, customerEmail };
}

export function fetchPublicAppointment(publicId: string): Promise<PublicAppointmentView> {
  return apiCall<PublicAppointmentView>(`/api/v1/public/appointments/${publicId}`);
}

// ---------------------------------------------------------------------------
// Owner-side reads
// ---------------------------------------------------------------------------

export interface OwnerAppointment {
  id: string;
  publicId: string;
  status: string;
  startsAt: string;
  customer: { firstName: string; lastName: string | null } | null;
  service: { id: string; name: string } | null;
}

/** The diary as the workspace's own staff see it. */
export function listAppointments(
  workspace: Pick<OwnerFixture, 'token' | 'businessId'>,
  query = '',
): Promise<OwnerAppointment[]> {
  return apiCall<OwnerAppointment[]>(`/api/v1/appointments?pageSize=100${query}`, {
    token: workspace.token,
    businessId: workspace.businessId,
  });
}

/**
 * Rewrites the workspace's customer-change deadlines.
 *
 * Exists because two specs used to assert the deadline behaviour by *assuming*
 * the first available opening fell inside a 24-hour window. Nothing pinned
 * that: `fetchPublicSlots` searches from tomorrow, so before ~09:00 local the
 * first opening is more than 24 hours out and the assertion inverts. The tests
 * passed all evening and failed first thing in the morning, which is the worst
 * shape a test failure can have — it looks like a regression and is not one.
 *
 * Setting the deadline explicitly turns the clock from an input into a
 * constant: whatever opening the search returns, a deadline of `minutes` either
 * definitely covers it or definitely does not.
 */
export async function setChangeDeadlines(
  owner: OwnerFixture,
  minutes: { reschedule: number; cancellation: number },
): Promise<void> {
  await apiCall('/api/v1/workspace/settings', {
    method: 'PATCH',
    token: owner.token,
    businessId: owner.businessId,
    body: {
      rescheduleDeadlineMinutes: minutes.reschedule,
      cancellationDeadlineMinutes: minutes.cancellation,
    },
  });
}

/** Far enough ahead that every opening the search can return sits inside it. */
export const DEADLINE_COVERS_EVERYTHING = 60 * 24 * 60;
