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

export type AppointmentSource = 'PUBLIC' | 'STAFF' | 'ADMIN' | 'WAITLIST' | 'IMPORT' | 'API';

export type AssignmentStrategy = 'ROUND_ROBIN' | 'POOLED' | 'SMART_MATCH' | 'LEAST_BUSY' | 'MANUAL';

/** Mirrors `LOCATION_TYPES` in the server's Location model — no more, no less. */
export type LocationType = 'PHYSICAL' | 'VIRTUAL' | 'PHONE' | 'CUSTOMER_SITE';

export type ResourceType = 'ROOM' | 'EQUIPMENT' | 'DESK' | 'VEHICLE' | 'OTHER';

export type BookingLinkType = 'CATALOG' | 'SINGLE_SERVICE' | 'TEAM' | 'STAFF';

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';

export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export type PlatformRole = 'USER' | 'ADMIN';

export type WaitlistStatus = 'ACTIVE' | 'HELD' | 'CONVERTED' | 'CANCELLED' | 'EXPIRED';

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
 * `activeWorkspace` is populated only when the request carried workspace
 * context. See `context/AuthContext.tsx` for how permissions are resolved when
 * it is null.
 */
export interface MeResponse {
  user: Pick<AuthUser, 'id' | 'email' | 'platformRole'>;
  memberships: Membership[];
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
  lastName: string;
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
    lastName: string;
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
