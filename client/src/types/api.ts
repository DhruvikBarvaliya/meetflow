/**
 * Types mirroring the MeetFlow REST contract.
 *
 * Every shape here was read from `server/src/modules/*` and confirmed against a
 * live response from the running API — nothing is inferred from a route name.
 *
 * Conventions the whole API keeps, and therefore so does this file:
 *
 *  - Instants are ISO-8601 strings **with an offset** (`2026-06-22T04:30:00.000Z`).
 *    Calendar dates are bare `YYYY-MM-DD`. The two are never interchangeable:
 *    a day is a property of a clock, so date-only fields are read in the
 *    workspace timezone.
 *  - Money is an integer in the currency's **minor units** (`350000` INR is
 *    ₹3,500.00). Use `formatMoney` from `lib/format`; never divide by 100 by
 *    hand, because not every currency has two decimal places.
 *  - Anything a customer could see is addressed by an opaque `publicId`
 *    (`apt_…`, `cus_…`), never by the internal UUID.
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
  [key: string]: unknown;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    requestId: string;
    meta?: Record<string, unknown>;
  };
}

/** `meta` on every paginated list endpoint. */
export interface PageMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

/** Stable machine codes from `server/src/utils/errors.ts`. */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'TOKEN_REVOKED',
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'TENANT_MISMATCH',
  'NOT_FOUND',
  'CONFLICT',
  'ALREADY_EXISTS',
  'SLOT_UNAVAILABLE',
  'RESOURCE_UNAVAILABLE',
  'CAPACITY_EXCEEDED',
  'POLICY_VIOLATION',
  'BOOKING_WINDOW_CLOSED',
  'INVALID_STATE_TRANSITION',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Every enum below names the server file it is sourced from, and each is a
 * `const` array rather than a bare union so a dropdown and a validator can be
 * built from the one list instead of retyping it.
 *
 * That provenance is not decoration. Four of these had silently drifted from
 * the models they mirror, and a client enum that offers a value the server's
 * `z.enum` rejects does not fail at compile time — it fails as a 422 in front of
 * whoever picked it. When one of these changes on the server, the named file is
 * where to check.
 */

/** Sourced from `APPOINTMENT_STATUSES` in server/src/database/models/Appointment.ts. */
export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'REJECTED',
  'RESCHEDULED',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Sourced from `APPOINTMENT_SOURCES` in server/src/database/models/Appointment.ts.
 *
 * `OWNER` is what the server stamps on a booking made from the management
 * surface, so it is the value this client sees most; `IMPORT` was never one of
 * them.
 */
export const APPOINTMENT_SOURCES = [
  'PUBLIC',
  'STAFF',
  'OWNER',
  'ADMIN',
  'API',
  'WAITLIST',
] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

/**
 * Sourced from `ASSIGNMENT_STRATEGIES` in server/src/database/models/Service.ts.
 * `TEAM_ASSIGNMENT_STRATEGIES` in Team.ts is the same four values, which is why
 * the services and teams forms share this list.
 *
 * `COLLECTIVE` books every eligible member at once, so availability becomes the
 * intersection of their free time rather than the union.
 */
export const ASSIGNMENT_STRATEGIES = [
  'ROUND_ROBIN',
  'COLLECTIVE',
  'POOLED',
  'SMART_MATCH',
] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/** Mirrors `LOCATION_TYPES` in the server's Location model — no more, no less. */
export type LocationType = 'PHYSICAL' | 'VIRTUAL' | 'PHONE' | 'CUSTOMER_SITE';

/** Sourced from `RESOURCE_TYPES` in server/src/database/models/Resource.ts. */
export const RESOURCE_TYPES = [
  'ROOM',
  'EQUIPMENT',
  'VEHICLE',
  'DESK',
  'FACILITY',
  'OTHER',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type BookingLinkType = 'CATALOG' | 'SINGLE_SERVICE' | 'TEAM' | 'STAFF';

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';

/**
 * Sourced from `USER_STATUSES` in server/src/database/models/User.ts, which is
 * also what the column's CHECK constraint enforces.
 *
 * The invited state is INVITED, not PENDING: an account created by an
 * invitation sits here until the invitation is accepted. PENDING belongs to
 * `AppointmentStatus` and never appears on a user.
 */
export type UserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';

export type PlatformRole = 'USER' | 'ADMIN';

/**
 * Sourced from `WAITLIST_STATUSES` in server/src/database/models/WaitlistEntry.ts.
 *
 * `NOTIFIED` is the state this client calls a held slot: the entry has been
 * told about an opening and owns it until `holdExpiresAt` passes. There is no
 * separate `HELD` status — the hold is a pair of timestamps on a notified row.
 */
export const WAITLIST_STATUSES = [
  'ACTIVE',
  'NOTIFIED',
  'CONVERTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export type NotifyChannel = 'EMAIL' | 'SMS' | 'BOTH';

/**
 * Mirrors `CUSTOM_QUESTION_TYPES` in the server's bookingLinks.validation.ts.
 *
 * The server validates an answer's JSON type per question — NUMBER must arrive
 * as a number and CHECKBOX as a boolean, not as the strings an input would
 * yield — so the booking form coerces before it submits.
 */
export type CustomQuestionType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'EMAIL'
  | 'PHONE'
  | 'URL'
  | 'DATE'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'CHECKBOX';

/** The four role templates the server seeds into every workspace. */
export const SYSTEM_ROLE_KEYS = ['BUSINESS_OWNER', 'MANAGER', 'RECEPTIONIST', 'STAFF'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** The full user record, returned by login / register / refresh. */
export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
  platformRole: PlatformRole;
  status: UserStatus;
  timezone: string;
  locale: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  expiresAt: string;
}

export interface Membership {
  membershipId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  timezone: string;
  roleKey: string;
  roleName: string;
  status: MembershipStatus;
}

/**
 * `GET /auth/me`.
 *
 * The route runs `optionalTenant`, so `activeWorkspace` is populated whenever a
 * workspace could be resolved — an `X-Business-Id` header, or a caller who
 * belongs to exactly one workspace. `permissions` on it is the server's own
 * effective set, with per-member GRANT and DENY overrides already applied by
 * the same resolver `requirePermission` runs through.
 *
 * Null is a real answer rather than a failure: a caller with no membership, or
 * one who belongs to several and has not named which, gets their memberships
 * back and nothing more. See `context/AuthContext.tsx` for what the UI assumes
 * in that window.
 */
export interface MeResponse {
  user: Pick<AuthUser, 'id' | 'email' | 'platformRole'>;
  memberships: Membership[];
  /**
   * How many workspaces hold a customer record for this person.
   *
   * Exists so the client can tell a brand-new business owner apart from a
   * customer when neither holds a membership. Both look identical otherwise,
   * and they belong in opposite places — onboarding, or their own bookings.
   */
  customerProfiles: number;
  activeWorkspace: {
    businessId: string;
    businessSlug: string;
    timezone: string;
    roleKey: string;
    staffProfileId: string | null;
    permissions: string[];
  } | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  timezone?: string;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requiresUppercase: boolean;
  requiresLowercase: boolean;
  requiresNumber: boolean;
  appUrl: string;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface BusinessSettings {
  businessId: string;
  slotIntervalMinutes: number;
  defaultPreBufferMinutes: number;
  defaultPostBufferMinutes: number;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  cancellationDeadlineMinutes: number;
  rescheduleDeadlineMinutes: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  maxReschedulesPerAppointment: number;
  requireApproval: boolean;
  maxBookingsPerCustomerPerDay: number | null;
  maxBookingsPerStaffPerDay: number | null;
  noShowGraceMinutes: number;
  waitlistEnabled: boolean;
  waitlistHoldMinutes: number;
  waitlistAutoBook: boolean;
  reminderOffsetsMinutes: number[];
  branding: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  description: string | null;
  industry: string | null;
  timezone: string;
  currency: string;
  locale: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  settings: BusinessSettings;
}

export interface CreateWorkspaceRequest {
  name: string;
  timezone: string;
  slug?: string;
  description?: string;
  industry?: string;
  currency?: string;
  locale?: string;
  websiteUrl?: string;
  supportEmail?: string;
  supportPhone?: string;
  createStaffProfile?: boolean;
}

export interface SlugAvailability {
  slug: string;
  available: boolean;
}

export interface Permission {
  id: string;
  key: string;
  category: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Role {
  id: string;
  businessId: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
  permissions: Permission[];
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  businessId: string;
  roleId: string;
  status: MembershipStatus;
  invitedByUserId: string | null;
  invitedAt: string | null;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    status: UserStatus;
  };
  role: { id: string; key: string; name: string };
  staffProfile: { id: string; displayName: string } | null;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface Location {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  type: LocationType;
  description: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string;
  phone: string | null;
  email: string | null;
  virtualMeetingUrl: string | null;
  capacity: number | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Team {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  description: string | null;
  assignmentStrategy: AssignmentStrategy;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StaffProfile {
  id: string;
  businessId: string;
  userId: string | null;
  membershipId: string | null;
  displayName: string;
  title: string | null;
  bio: string | null;
  avatarUrl: string | null;
  timezone: string;
  color: string | null;
  defaultLocationId: string | null;
  isBookable: boolean;
  preBufferMinutes: number | null;
  postBufferMinutes: number | null;
  minNoticeMinutes: number | null;
  maxDailyAppointments: number | null;
  maxWeeklyAppointments: number | null;
  lastAssignedAt: string | null;
  assignmentWeight: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  user?: { id: string; firstName: string; lastName: string; avatarUrl: string | null } | null;
}

export interface Resource {
  id: string;
  businessId: string;
  locationId: string | null;
  name: string;
  slug: string;
  type: ResourceType;
  description: string | null;
  capacity: number;
  color: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  location?: Pick<Location, 'id' | 'name' | 'slug' | 'type' | 'timezone' | 'isActive'> | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface ServiceCategory {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface Service {
  id: string;
  businessId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  preBufferMinutes: number | null;
  postBufferMinutes: number | null;
  /** Minor units of `currency`. */
  priceAmount: number;
  currency: string;
  capacity: number;
  minNoticeMinutes: number | null;
  maxHorizonDays: number | null;
  slotIntervalMinutes: number | null;
  maxPerCustomerPerDay: number | null;
  requiresApproval: boolean;
  assignmentStrategy: AssignmentStrategy;
  color: string | null;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  category?: ServiceCategory | null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  businessId: string;
  publicId: string;
  userId: string | null;
  firstName: string;
  /**
   * Nullable: `customers.last_name` is `allowNull: true` and the create/update
   * validators both accept it as optional. Render with `customerName` from
   * `lib/format` — interpolating this straight into a template prints the
   * literal string "null" next to the first name.
   */
  lastName: string | null;
  email: string | null;
  phone: string | null;
  timezone: string | null;
  locale: string | null;
  notes: string | null;
  tags: string[];
  preferredStaffProfileId: string | null;
  preferredLocationId: string | null;
  communicationPreferences: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    marketingOptIn: boolean;
  };
  status: 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';
  totalBookings: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  firstAppointmentAt: string | null;
  lastAppointmentAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/** A row in the diary list / calendar. */
export interface Appointment {
  id: string;
  publicId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timezone: string;
  capacity: number;
  bookedCount: number;
  /** Minor units of `currency`. */
  priceAmount: number;
  currency: string;
  source: AppointmentSource;
  title: string | null;
  requiresApproval: boolean;
  checkedInAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  serviceId: string | null;
  staffProfileId: string | null;
  locationId: string | null;
  customerId: string | null;
  service: Pick<Service, 'id' | 'name' | 'slug' | 'durationMinutes' | 'color'> | null;
  staffProfile: { id: string; displayName: string } | null;
  location: { id: string; name: string; timezone: string } | null;
  customer: {
    id: string;
    publicId: string;
    firstName: string;
    /** Nullable for the same reason as `Customer.lastName`. */
    lastName: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
}

export interface AppointmentListFilters {
  page?: number;
  pageSize?: number;
  status?: AppointmentStatus | AppointmentStatus[];
  from?: string;
  to?: string;
  staffProfileId?: string;
  serviceId?: string;
  locationId?: string;
  customerId?: string;
  q?: string;
}

// ---------------------------------------------------------------------------
// Booking links
// ---------------------------------------------------------------------------

export interface CustomQuestion {
  key: string;
  type: CustomQuestionType;
  label: string;
  required: boolean;
  options?: string[];
  helpText?: string;
}

export interface BookingLink {
  id: string;
  businessId: string;
  slug: string;
  name: string;
  description: string | null;
  type: BookingLinkType;
  serviceId: string | null;
  teamId: string | null;
  staffProfileId: string | null;
  locationId: string | null;
  allowStaffSelection: boolean;
  requiresApproval: boolean;
  customQuestions: CustomQuestion[];
  branding: Record<string, unknown>;
  maxBookingsTotal: number | null;
  bookingCount: number;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  publicUrl: string;
  isBookable: boolean;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export interface WaitlistEntry {
  id: string;
  publicId: string;
  businessId: string;
  customerId: string;
  serviceId: string | null;
  staffProfileId: string | null;
  locationId: string | null;
  /** Calendar dates in `timezone`, not instants. */
  earliestDate: string;
  latestDate: string;
  /** Minutes past local midnight. */
  earliestMinute: number;
  latestMinute: number;
  /** ISO weekday numbers, 1 = Monday. */
  daysOfWeek: number[];
  timezone: string;
  status: WaitlistStatus;
  priority: number;
  notifyChannel: NotifyChannel;
  notifiedAt: string | null;
  notificationCount: number;
  holdExpiresAt: string | null;
  heldSlotStartsAt: string | null;
  convertedAppointmentId: string | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: Pick<
    Customer,
    'id' | 'publicId' | 'firstName' | 'lastName' | 'email' | 'phone' | 'timezone'
  > | null;
  service?: Pick<Service, 'id' | 'name' | 'slug' | 'durationMinutes'> | null;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** Every analytics endpoint takes this window; `from`/`to` are required. */
export interface AnalyticsRange {
  from: string;
  to: string;
  locationId?: string;
  staffProfileId?: string;
}

export interface AnalyticsOverview {
  totalBookings: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  noShows: number;
  reschedules: number;
  /** Ratio in 0..1, already rounded by the server. */
  cancellationRate: number;
  noShowRate: number;
  newCustomers: number;
  returningCustomers: number;
  averageLeadTimeHours: number;
  averageDurationMinutes: number;
  /** Minor units of `currency`. */
  revenueAmount: number;
  currency: string;
}

export interface AnalyticsRangeMeta {
  range: { from: string; to: string; timezone: string };
}

// ---------------------------------------------------------------------------
// Public booking surface (no auth)
// ---------------------------------------------------------------------------

export interface PublicBusiness {
  name: string;
  description: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  timezone: string;
  currency: string;
  locale: string;
  supportEmail: string | null;
  supportPhone: string | null;
}

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  capacity: number;
  requiresApproval: boolean;
}

export interface PublicLocation {
  id: string;
  name: string;
  type: LocationType;
  timezone: string;
  address: string | null;
  virtualMeetingUrl?: string | null;
}

export interface PublicStaff {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicBookingPolicy {
  timezone: string;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  cancellationDeadlineMinutes: number;
  rescheduleDeadlineMinutes: number;
  maxReschedulesPerAppointment: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  requiresApproval: boolean;
}

export interface PublicBookingLink {
  link: {
    slug: string;
    name: string;
    description: string | null;
    type: BookingLinkType;
    allowStaffSelection: boolean;
    expiresAt: string | null;
    branding: Record<string, unknown>;
  };
  business: PublicBusiness;
  services: PublicService[];
  locations: PublicLocation[];
  staff: PublicStaff[];
  questions: CustomQuestion[];
  policy: PublicBookingPolicy;
}

export interface PublicAppointment {
  publicId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timezone: string;
  priceAmount: number;
  currency: string;
  title: string | null;
  customerNotes: string | null;
  answers: Record<string, unknown>;
  requiresApproval: boolean;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  rescheduleCount: number;
  service: { id: string; name: string; description: string | null } | null;
  staff: PublicStaff | null;
  location: PublicLocation | null;
  business: Pick<PublicBusiness, 'name' | 'logoUrl' | 'timezone' | 'supportEmail' | 'supportPhone'>;
  /**
   * Given name only, and null when the record has been erased. The `apt_…`
   * handle behaves like a bearer token, so the server withholds contact details
   * from anyone who merely forwards the link.
   */
  customer: { firstName: string; lastName: string | null } | null;
  policy: {
    canCancel: boolean;
    canReschedule: boolean;
    cancellationDeadlineMinutes: number;
    rescheduleDeadlineMinutes: number;
    remainingReschedules: number;
  };
  manageUrl: string;
}

/** One bookable opening. `staffProfileId` names the provider it belongs to. */
export interface PublicSlot {
  startsAt: string;
  endsAt: string;
  staffProfileId: string;
  staffName: string;
  locationId: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  /** Present only on group services, where several people share one session. */
  remainingCapacity?: number;
}

export interface PublicAvailability {
  slots: PublicSlot[];
  timezone: string;
  /** True when the search hit its ceiling — there may be more times than shown. */
  truncated: boolean;
  /**
   * The *effective* policy for this service, which is what availability was
   * computed against. It can be narrower than the workspace defaults in
   * `PublicBookingPolicy`, so the booking window is driven from here.
   */
  service: {
    durationMinutes: number;
    priceAmount: number;
    currency: string;
    capacity: number;
    minNoticeMinutes: number;
    maxHorizonDays: number;
    requiresApproval: boolean;
  };
}

/**
 * The result of POSTing a booking.
 *
 * Note the nesting: the appointment is under `appointment`, not spread across
 * the top level. `replayed` is true when an idempotency key matched an earlier
 * request, in which case the server answers 200 with the original booking
 * instead of creating a second one.
 */
export interface PublicBookingConfirmation {
  appointment: {
    publicId: string;
    status: AppointmentStatus;
    startsAt: string;
    endsAt: string;
    durationMinutes: number;
    timezone: string;
    priceAmount: number;
    currency: string;
    title: string | null;
    requiresApproval: boolean;
    serviceId: string;
    staffProfileId: string | null;
    locationId: string | null;
  };
  /** This person's place in the session; meaningful on group bookings. */
  participantPublicId: string;
  manageUrl: string;
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Platform administration
// ---------------------------------------------------------------------------

/**
 * `/api/v1/admin` — the operator's surface, read from
 * `server/src/modules/admin/admin.service.ts`.
 *
 * Two properties of this contract are visible in the shapes below and are the
 * reason they look the way they do.
 *
 * **It is not tenant-scoped.** A platform admin holds no membership in the
 * workspaces they administer, so nothing here is resolved from the caller's
 * session: a workspace id is an ordinary parameter. That is also why these
 * types sit apart from the `Workspace` and `WorkspaceMember` shapes above,
 * which describe the workspace you belong to rather than one you are looking
 * in on.
 *
 * **It exposes workspaces, platform accounts and counts — never contents.**
 * There is no admin type for a customer, an appointment or a note, because the
 * API has no field to put one in. Someone running the platform has no business
 * reading a clinic's patient list, and the shape of the response is what
 * enforces that rather than a filter someone could forget. If a screen ever
 * seems to need a name or an address from here, that is a contract argument to
 * have on the server, not a type to widen quietly.
 */

/** Mirrors `BUSINESS_STATUSES` in the server's Business model. */
export type AdminWorkspaceStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

/**
 * The statuses an operator may *set* on an account — `UserStatus` minus one.
 *
 * INVITED is a state the invitation flow enters and that accepting an
 * invitation leaves. Set by hand it would produce an account waiting for an
 * invitation nobody sent, and nothing in the product would resolve that, so the
 * server's schema refuses it. Offering it in the UI would only ever yield a
 * validation error.
 */
export type AdminUserStatusUpdate = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

/** Mirrors `AUDIT_ACTOR_TYPES` in the server's AuditLog model. */
export type AdminAuditActorType = 'USER' | 'CUSTOMER' | 'SYSTEM' | 'PUBLIC' | 'API';

/** `GET /admin/overview` — one request behind the whole landing screen. */
export interface AdminOverview {
  workspaces: {
    total: number;
    active: number;
    suspended: number;
    archived: number;
    createdLast30Days: number;
  };
  users: {
    total: number;
    active: number;
    invited: number;
    suspended: number;
    deactivated: number;
    admins: number;
    createdLast30Days: number;
  };
  appointments: {
    total: number;
    upcoming: number;
    last30Days: number;
    cancelledLast30Days: number;
  };
  /** A count only. The admin surface never lists a customer. */
  customers: { total: number };
  /**
   * The last 14 days inclusive of today, counted in **UTC** days and
   * zero-filled: a quiet day arrives as a zero rather than as a missing key, so
   * a chart can plot the series straight through without reindexing it. UTC
   * rather than workspace days because the series spans every timezone on the
   * platform at once, and no single one of them is the right answer.
   */
  bookingsByDay: Array<{ date: string; count: number }>;
  /** The five busiest workspaces of the last 30 days, most bookings first. */
  topWorkspaces: Array<{
    businessId: string;
    name: string;
    slug: string;
    status: AdminWorkspaceStatus;
    appointmentsLast30Days: number;
  }>;
  generatedAt: string;
}

export interface AdminWorkspaceOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * What a workspace holds *now*.
 *
 * Every count but `appointments` excludes soft-deleted rows, because the
 * question an operator is asking is what the workspace has today rather than
 * what it has ever had. Appointments have no soft delete at all — a cancelled
 * booking keeps its row as history — so that figure is the lifetime total and
 * the cancelled ones are inside it.
 */
export interface AdminWorkspaceCounts {
  members: number;
  staff: number;
  services: number;
  locations: number;
  appointments: number;
  customers: number;
}

/** A row in `GET /admin/workspaces`. */
export interface AdminWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: AdminWorkspaceStatus;
  timezone: string;
  currency: string;
  industry: string | null;
  /** Null when the owning account has been soft-deleted out from under it. */
  owner: AdminWorkspaceOwner | null;
  counts: AdminWorkspaceCounts;
  /** Null for a workspace that has never taken a booking. */
  lastAppointmentAt: string | null;
  createdAt: string;
}

export interface AdminWorkspaceMember {
  membershipId: string;
  status: MembershipStatus;
  roleKey: string;
  roleName: string;
  /** Null while an invitation is outstanding — nobody has joined yet. */
  joinedAt: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    status: UserStatus;
    platformRole: PlatformRole;
  };
}

/**
 * One audit row, trimmed to what a workspace panel shows.
 *
 * Deliberately narrower than `AdminAuditEntry`: this list sits inside a
 * workspace the operator does not belong to, so it carries the verb and who
 * performed it and nothing about what was booked or said.
 */
export interface AdminWorkspaceActivity {
  id: string;
  action: string;
  entityType: string;
  /** Null for system actors, which have no account to name. */
  actorLabel: string | null;
  createdAt: string;
}

/**
 * The appointment mix for one workspace.
 *
 * The server types `status` as a bare string because it reads the column
 * without interpreting it; the CHECK constraint on that column admits nothing
 * outside `AppointmentStatus`, which is what lets the status badges consume
 * this list directly.
 */
export interface AdminAppointmentStatusCount {
  status: AppointmentStatus;
  count: number;
}

/** `GET /admin/workspaces/:id`, and the answer to the status PATCH. */
export interface AdminWorkspaceDetail extends AdminWorkspaceSummary {
  legalName: string | null;
  description: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  /** Not nullable: the column has a default, unlike the five above it. */
  locale: string;
  members: AdminWorkspaceMember[];
  appointmentsByStatus: AdminAppointmentStatusCount[];
  /** The last 20 audit rows for this workspace, most recent first. */
  recentActivity: AdminWorkspaceActivity[];
}

/** The body of `PATCH /admin/workspaces/:id/status`. */
export interface AdminWorkspaceStatusUpdate {
  status: AdminWorkspaceStatus;
  /**
   * Recorded in the audit row and nowhere else. Suspending a paying customer's
   * workspace is the kind of action that gets asked about weeks later, and the
   * trail is worth far more when it says why. The server refuses an empty
   * string, so an untouched field has to be omitted rather than sent blank —
   * `updateAdminWorkspaceStatus` does that for its callers.
   */
  reason?: string;
}

/** A row in `GET /admin/users`. */
export interface AdminUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  platformRole: PlatformRole;
  status: UserStatus;
  emailVerified: boolean;
  lastLoginAt: string | null;
  /** How many workspaces this account belongs to, and how many it owns. */
  workspaceCount: number;
  ownedWorkspaceCount: number;
  createdAt: string;
}

export interface AdminUserMembership {
  membershipId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessStatus: AdminWorkspaceStatus;
  roleKey: string;
  roleName: string;
  status: MembershipStatus;
  joinedAt: string | null;
  /** True when this account owns the workspace rather than merely joining it. */
  isOwner: boolean;
}

/** `GET /admin/users/:id`, and the answer to both user PATCHes. */
export interface AdminUserDetail extends AdminUserSummary {
  phone: string | null;
  timezone: string;
  locale: string;
  /**
   * Set by the login throttle, so a value in the future is the reason a support
   * ticket says "I cannot sign in" while the status still reads ACTIVE. It is
   * the first thing worth checking on this screen.
   */
  lockedUntil: string | null;
  failedLoginCount: number;
  /** Live refresh-token families: how many devices are still signed in. */
  activeSessionCount: number;
  memberships: AdminUserMembership[];
}

/** A row in `GET /admin/audit-logs`, ordered newest first. */
export interface AdminAuditEntry {
  id: string;
  /** Null for platform-level actions, which belong to no workspace. */
  businessId: string | null;
  businessName: string | null;
  actorType: AdminAuditActorType;
  actorLabel: string | null;
  actorUserId: string | null;
  /** The dotted verb, e.g. `appointment.cancelled`. */
  action: string;
  entityType: string;
  entityId: string | null;
  /** Ties a row back to one request in the server logs. */
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
  /**
   * Whatever the writing module recorded. The shape varies by action, so it is
   * read defensively rather than cast, and never used as a lookup key.
   */
  metadata: Record<string, unknown>;
}

/**
 * `GET /admin/health`.
 *
 * Answered with a 200 even when a dependency is down: the endpoint reports on
 * the platform rather than on itself, and a 503 would make the one page that
 * could explain an outage disappear during one. Read `ok`, never the status
 * code.
 */
export interface AdminHealth {
  database: { ok: boolean; latencyMs: number; error: string | null };
  redis: { ok: boolean; latencyMs: number; error: string | null };
  outbox: {
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
    /** PENDING and already due — the backlog that ought to be draining now. */
    dueNow: number;
    /**
     * Null means nothing is pending at all, which is not the same as "the
     * oldest pending message is zero seconds old". Render the two differently.
     */
    oldestPendingAgeSeconds: number | null;
  };
  api: { environment: string; node: string; uptimeSeconds: number; apiVersion: 'v1' };
  generatedAt: string;
}

export type AdminWorkspaceSort = 'newest' | 'oldest' | 'name' | 'appointments';

export type AdminUserSort = 'newest' | 'oldest' | 'name' | 'lastLogin';

/*
 * The filter shapes each admin list page holds in state.
 *
 * Every field is required, and "unset" is the empty string rather than
 * `undefined`, for two reasons. A `useState` initialiser stays total, so adding
 * a filter later breaks compilation at every call site instead of quietly
 * defaulting. And `toSearchParams` drops empty strings, so this state can go
 * straight to the query string with no per-field ternary — which matters
 * because the server's query schemas are `.strict()` and reject an empty
 * `?search=` rather than treating it as absent.
 */

export interface AdminWorkspaceFilters {
  page: number;
  search: string;
  status: AdminWorkspaceStatus | '';
  sort: AdminWorkspaceSort;
}

export interface AdminUserFilters {
  page: number;
  search: string;
  status: UserStatus | '';
  platformRole: PlatformRole | '';
  sort: AdminUserSort;
}

export interface AdminAuditFilters {
  page: number;
  businessId: string;
  action: string;
  entityType: string;
  /** Calendar dates, `YYYY-MM-DD`, both bounds inclusive and read as UTC days. */
  from: string;
  to: string;
  /**
   * Accepted by the endpoint but not yet surfaced as a control, so that a link
   * from a user's detail page can pre-filter the log to that account.
   */
  actorUserId?: string;
}

// ---------------------------------------------------------------------------
// Workspace administration
// ---------------------------------------------------------------------------

/*
 * Members, the workspace's own audit trail and outbound webhooks — the three
 * surfaces under `/api/v1/members`, `/api/v1/audit-logs` and `/api/v1/webhooks`.
 *
 * All three are mounted on the tenant-scoped management router, so **no shape
 * below carries a `businessId`**. The workspace is resolved from the caller's
 * membership and no parameter these endpoints accept can widen it; echoing the
 * id back would imply a feed that could ever contain another tenant's rows.
 * That is the one property to preserve if anything here is extended.
 *
 * Every date arrives as an ISO-8601 instant even where the service types it as
 * a `Date` — it has been through `JSON.stringify` by the time this client sees
 * it — so the fields below are `string`, matching the rest of this file.
 */

// --- Members ---------------------------------------------------------------

/**
 * Sourced from `PERMISSION_EFFECTS` in
 * server/src/database/models/MembershipPermission.ts.
 *
 * A DENY beats both the role and a GRANT, which is the whole point of the
 * table: revoking one capability from one person without cloning a role.
 */
export const MEMBERSHIP_PERMISSION_EFFECTS = ['GRANT', 'DENY'] as const;
export type MembershipPermissionEffect = (typeof MEMBERSHIP_PERMISSION_EFFECTS)[number];

/**
 * The statuses `GET /members` will filter on, from `listableStatusSchema` in
 * members.validation.ts.
 *
 * REMOVED is absent deliberately: a removed membership is soft deleted, so it
 * is excluded by the paranoid scope rather than by its status. `includeRemoved`
 * is the switch that brings those rows back, not a status value.
 */
export const MEMBER_LISTABLE_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED'] as const;
export type MemberListableStatus = (typeof MEMBER_LISTABLE_STATUSES)[number];

/**
 * A row from `GET /members` — `MemberView` in members.service.ts.
 *
 * Distinct from `WorkspaceMember` above, which is the older unpaginated
 * `GET /workspace/members` shape that `StaffPage` still reads. Two fields make
 * this the one an administration screen needs: `isOwner`, which is the guard
 * the server actually enforces rather than something inferable from a role key,
 * and `removedAt`, which is how a past member is told apart from a present one
 * once `includeRemoved` is on.
 */
export interface MemberRecord {
  /** The *membership* id. Every write below is addressed by this, not by user id. */
  id: string;
  status: MembershipStatus;
  /** The account in `businesses.owner_user_id`, whose membership is immutable. */
  isOwner: boolean;
  invitedAt: string | null;
  joinedAt: string | null;
  createdAt: string;
  /** Non-null only on rows fetched with `includeRemoved`. */
  removedAt: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    /** Built on the server, so a member's name is joined in exactly one place. */
    fullName: string;
    avatarUrl: string | null;
    /**
     * The service types this as a bare `string` because it reads the column
     * without interpreting it; the CHECK constraint on `users.status` admits
     * nothing outside `UserStatus`.
     */
    status: UserStatus;
  };
  role: { id: string; key: string; name: string };
  staffProfile: { id: string; displayName: string; isBookable: boolean; isActive: boolean } | null;
}

export interface MemberPermissionOverride {
  /** A key from the catalogue, e.g. `appointments:cancel`. */
  permission: string;
  effect: MembershipPermissionEffect;
}

/**
 * `GET /members/{id}/permissions` — what one member may do, and why.
 *
 * The three lists are not redundant. `rolePermissions` is what the role grants
 * before any exception, `overrides` is the per-member exception set, and
 * `effectivePermissions` is what `requirePermission` will actually enforce.
 * Showing only the last would make an override indistinguishable from a role
 * that happens to grant the same thing, which is the distinction an operator
 * opens this panel to see.
 */
export interface MemberPermissions {
  membershipId: string;
  role: { id: string; key: string; name: string };
  rolePermissions: string[];
  overrides: MemberPermissionOverride[];
  effectivePermissions: string[];
}

export interface InviteMemberRequest {
  email: string;
  roleId: string;
  /**
   * Consulted only when the address has no account yet, because `users`
   * requires a name. Sending them for a colleague who already has an account
   * changes nothing — an invitation must not be able to rewrite somebody's
   * profile.
   */
  firstName?: string;
  lastName?: string;
}

/**
 * INVITED and REMOVED are not settable. INVITED is written by the invitation
 * path and cleared by acceptance; REMOVED belongs to `DELETE /members/{id}`,
 * which also soft deletes the row so the address can be invited again.
 */
export interface UpdateMemberRequest {
  roleId?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}

export interface MemberFilters {
  page: number;
  search: string;
  status: MemberListableStatus | '';
  roleId: string;
  /** Brings soft-deleted rows back, so somebody who left can be found. */
  includeRemoved: boolean;
}

// --- Audit trail -----------------------------------------------------------

/**
 * Sourced from `AUDIT_ACTOR_TYPES` in server/src/database/models/AuditLog.ts.
 *
 * `AdminAuditActorType` above names the same five values off the same column;
 * it predates this array and belongs to the platform surface, which this file
 * keeps separate throughout. Anything new should build on the array, since a
 * dropdown and a lookup can then be derived from one list.
 */
export const AUDIT_ACTOR_TYPES = ['USER', 'CUSTOMER', 'SYSTEM', 'PUBLIC', 'API'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * A row from `GET /audit-logs`, newest first.
 *
 * Tenant-scoped, so unlike `AdminAuditEntry` there is no `businessId` and no
 * `businessName`: every row belongs to the caller's own workspace, and no
 * platform-level entry can appear here at all.
 */
export interface AuditLogEntry {
  id: string;
  actorType: AuditActorType;
  /** Nulled when the account behind the entry is deleted — see `actorLabel`. */
  actorUserId: string | null;
  actorCustomerId: string | null;
  /** The snapshot that survives that deletion, e.g. an email address. */
  actorLabel: string | null;
  /** The dotted verb, e.g. `appointment.cancelled`. */
  action: string;
  entityType: string;
  entityId: string | null;
  /** Correlates the entry with one request in the server logs. */
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
  /**
   * Whatever the writing module recorded, already through the server's
   * `sanitiseMetadata`. The shape varies by action, so it is read defensively
   * rather than cast, and never used as a lookup key.
   */
  metadata: Record<string, unknown>;
}

/**
 * `GET /audit-logs/{id}`. One column wider than a list row: the user agent is
 * long, repetitive and near-useless twenty rows at a time, and is exactly what
 * an investigation into a single entry wants.
 */
export interface AuditLogEntryDetail extends AuditLogEntry {
  userAgent: string | null;
}

export interface AuditLogFilters {
  page: number;
  /** Exact match on the dotted verb — not a prefix search. */
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string;
  /** Free text over the actor snapshot, the action and the entity type. */
  search: string;
  /** Calendar dates, `YYYY-MM-DD`, both bounds inclusive, cut into whole days. */
  from: string;
  to: string;
}

// --- Webhooks --------------------------------------------------------------

/** Sourced from `WEBHOOK_DELIVERY_STATUSES` in models/WebhookDelivery.ts. */
export const WEBHOOK_DELIVERY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Subscribes to everything, including events added later. */
export const WEBHOOK_WILDCARD_EVENT = '*';

/**
 * Sourced from `SUBSCRIBABLE_WEBHOOK_EVENTS` in webhooks.validation.ts.
 *
 * `webhook.test` is deliberately not here: a test is delivered because somebody
 * asked for it on one endpoint, not because anybody subscribed to it, so it is
 * sent by `POST /webhooks/{id}/test` and appears in delivery history under that
 * name without ever being selectable.
 */
export const SUBSCRIBABLE_WEBHOOK_EVENTS = [
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.completed',
  'appointment.no_show',
] as const;
export type SubscribableWebhookEvent = (typeof SUBSCRIBABLE_WEBHOOK_EVENTS)[number];

/**
 * A registered delivery target.
 *
 * There is no `signingSecret` field, and its absence is the contract rather
 * than an omission: the secret is readable exactly once, in the 201 from
 * `POST /webhooks` — see `CreatedWebhookEndpoint`. Nothing else in the API ever
 * returns one.
 */
export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  /** Event names, or `['*']` for the wildcard. */
  events: string[];
  isActive: boolean;
  /**
   * Consecutive failed deliveries. Reset to zero on a success and on
   * re-activation; at twenty the worker switches the endpoint off and stamps
   * `disabledAt`.
   */
  failureCount: number;
  /** When the endpoint was switched off, by the worker or by an operator. */
  disabledAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The 201 body from `POST /webhooks`, and the only shape in the API that
 * carries a signing secret. It exists in one variable on the server, in one
 * function; no endpoint can read it back afterwards, so a client that fails to
 * show it has cost the user the secret.
 */
export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  signingSecret: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  event: string;
  /** Stable across every endpoint notified of one occurrence. */
  eventId: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  responseStatus: number | null;
  /** Already truncated by the worker; a verbose subscriber cannot bloat this. */
  responseBody: string | null;
  error: string | null;
  scheduledFor: string;
  deliveredAt: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

/** `GET /webhooks/{id}` — the endpoint plus its ten most recent deliveries. */
export interface WebhookEndpointDetail extends WebhookEndpoint {
  recentDeliveries: WebhookDeliveryRecord[];
}

export interface CreateWebhookRequest {
  url: string;
  description?: string | null;
  /** Omitted means the column default, `['*']`. */
  events?: string[];
  isActive?: boolean;
}

/**
 * The signing secret is not updatable, and its absence is the point: a
 * caller-supplied secret would be a caller-chosen one, and rotation is a
 * separate operation with its own overlap window. Neither is smuggled into a
 * PATCH — rotating today means registering a second endpoint and deleting the
 * first.
 */
export interface UpdateWebhookRequest {
  url?: string;
  description?: string | null;
  events?: string[];
  isActive?: boolean;
}

export interface WebhookFilters {
  page: number;
  /**
   * The query parameter is the literal string `true` or `false`, not a boolean:
   * the server spells the two out because `z.coerce.boolean()` maps `"false"`
   * to `true` and would return exactly the rows the filter excludes.
   */
  isActive: 'true' | 'false' | '';
  event: string;
}

export interface WebhookDeliveryFilters {
  page: number;
  status: WebhookDeliveryStatus | '';
  event: string;
}

// ---------------------------------------------------------------------------
// Notification templates
//
// `GET /notification-templates`. The list is the whole catalogue, not the
// override rows: a workspace that has never edited a message still needs to see
// what is being sent in its name.
// ---------------------------------------------------------------------------

export const NOTIFICATION_TEMPLATE_KEYS = [
  'BOOKING_CONFIRMATION',
  'BOOKING_PENDING_APPROVAL',
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'BOOKING_CANCELLED',
  'BOOKING_RESCHEDULED',
  'APPOINTMENT_REMINDER',
  'APPOINTMENT_FOLLOW_UP',
  'APPOINTMENT_NO_SHOW',
  'WAITLIST_SLOT_AVAILABLE',
  'WAITLIST_CONFIRMED',
  'STAFF_ASSIGNED',
  'STAFF_SCHEDULE_CHANGED',
  'OWNER_DAILY_DIGEST',
  'OWNER_NEW_BOOKING',
  'CUSTOMER_WELCOME',
] as const;
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

export const NOTIFICATION_TEMPLATE_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationTemplateChannel = (typeof NOTIFICATION_TEMPLATE_CHANNELS)[number];

export interface TemplatePlaceholder {
  name: string;
  description: string;
}

export interface NotificationTemplate {
  key: NotificationTemplateKey;
  channel: NotificationTemplateChannel;
  locale: string;
  /** What will actually be sent. Null on channels with no subject line. */
  subject: string | null;
  bodyText: string;
  /**
   * `BUILT_IN` messages improve when MeetFlow improves them; `WORKSPACE`
   * messages do not. That difference is the point of the screen.
   */
  source: 'WORKSPACE' | 'BUILT_IN';
  /** False both when there is no override and when one is parked. */
  isActive: boolean;
  defaultSubject: string | null;
  defaultBodyText: string | null;
  placeholders: TemplatePlaceholder[];
  updatedAt: string | null;
}

/**
 * No `bodyHtml`, and there will not be one: the HTML part is generated from the
 * text with every interpolated value escaped, so tenant-authored markup never
 * reaches a message MeetFlow's own domain signs.
 */
export interface UpsertNotificationTemplateRequest {
  subject?: string;
  bodyText: string;
  isActive?: boolean;
}

export interface NotificationTemplatePreview {
  subject: string | null;
  bodyText: string;
  /** Null for channels with no HTML part. */
  bodyHtml: string | null;
  placeholdersUsed: string[];
}
