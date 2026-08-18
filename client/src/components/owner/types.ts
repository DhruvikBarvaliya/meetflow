/**
 * Shapes the management surface needs that `@/types/api` does not already carry.
 *
 * Everything here was read from `server/src/modules/*` and confirmed against a
 * live response from the running API. The same conventions apply: instants are
 * offset-bearing ISO strings, calendar dates are bare `YYYY-MM-DD`, money is an
 * integer in the currency's minor units, and ratios are 0..1 rather than
 * percentages.
 */

import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  AssignmentStrategy,
  Customer,
  Location,
  ResourceType,
  Service,
  StaffProfile,
  Team,
} from '@/types/api';

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** `GET /analytics/trends` — one bucket per calendar day in the window. */
export interface TrendBucket {
  date: string;
  bookings: number;
  completed: number;
  cancelled: number;
  /** Minor units of the workspace currency. */
  revenue: number;
}

/** `GET /analytics/staff`. `workingMinutes` is the rota, not the clock. */
export interface StaffPerformance {
  staffProfileId: string;
  displayName: string;
  appointments: number;
  completed: number;
  noShows: number;
  bookedMinutes: number;
  workingMinutes: number;
  utilisationRate: number;
  revenue: number;
}

/** `GET /analytics/services`. Duration is observed, not the configured length. */
export interface ServicePerformance {
  serviceId: string;
  name: string;
  bookings: number;
  completed: number;
  cancelled: number;
  revenue: number;
  averageDurationMinutes: number;
}

/** `GET /analytics/locations`. The denominator is the site's opening hours. */
export interface LocationPerformance {
  locationId: string;
  name: string;
  bookings: number;
  bookedMinutes: number;
  openMinutes: number;
  utilisationRate: number;
}

/**
 * `GET /analytics/peak-times`.
 *
 * Only observed buckets come back — an hour with no bookings is absent rather
 * than zero, so a grid has to be filled in on the client.
 */
export interface PeakTimeBucket {
  /** Sunday = 0 … Saturday = 6, in the workspace's zone. */
  weekday: number;
  /** Hour of the local day, 0–23. */
  hour: number;
  bookings: number;
}

export interface TopCustomer {
  customerId: string;
  publicId: string;
  name: string;
  appointments: number;
  completed: number;
  revenue: number;
}

/** `GET /analytics/customers`. */
export interface CustomerAnalytics {
  activeCustomers: number;
  repeatCustomers: number;
  repeatRate: number;
  newVsReturning: { new: number; returning: number };
  topCustomers: TopCustomer[];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** One row of `GET /reports/appointments`. */
export interface AppointmentReportRow {
  bookingReference: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  /** The same instant on the workspace clock, already rendered: `YYYY-MM-DD HH:mm`. */
  startsAtLocal: string;
  timezone: string;
  durationMinutes: number;
  service: string | null;
  staff: string | null;
  location: string | null;
  customerName: string | null;
  customerEmail: string | null;
  priceAmount: number;
  currency: string;
  source: AppointmentSource;
  rescheduleCount: number;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  noShowAt: string | null;
  cancellationReason: string | null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** One block on the calendar grid: enough to draw and label it, nothing more. */
export interface CalendarEvent {
  id: string;
  publicId: string;
  title: string | null;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  timezone: string;
  serviceId: string;
  serviceName: string | null;
  color: string | null;
  staffProfileId: string | null;
  staffName: string | null;
  locationId: string | null;
  customerName: string | null;
  capacity: number;
  bookedCount: number;
}

/** `meta` on `GET /appointments/calendar`; `truncated` means the window overflowed. */
export interface CalendarMeta {
  from: string;
  to: string;
  count: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Appointment detail
// ---------------------------------------------------------------------------

/** The full row, as `GET /appointments/:id` returns it under `appointment`. */
export interface AppointmentRecord extends Appointment {
  businessId: string;
  teamId: string | null;
  bookingLinkId: string | null;
  bufferStartAt: string;
  bufferEndAt: string;
  preBufferMinutes: number;
  postBufferMinutes: number;
  customerNotes: string | null;
  internalNotes: string | null;
  answers: Record<string, unknown>;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  noShowAt: string | null;
  cancellationReason: string | null;
  cancelledByType: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'SYSTEM' | null;
  lateCancellation: boolean;
  rescheduledFromId: string | null;
  rescheduleCount: number;
  updatedAt: string;
}

export interface AppointmentStatusHistoryEntry {
  id: string;
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus;
  actorType: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'SYSTEM';
  actorLabel: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RescheduleHistoryEntry {
  id: string;
  previousStartsAt: string;
  newStartsAt: string;
  previousStaffProfileId: string | null;
  newStaffProfileId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AppointmentParticipantEntry {
  id: string;
  publicId: string;
  role: string;
  status: string;
  customer: Pick<
    Customer,
    'id' | 'publicId' | 'firstName' | 'lastName' | 'email' | 'phone' | 'timezone'
  > | null;
}

export interface AppointmentDetail {
  appointment: AppointmentRecord;
  participants: AppointmentParticipantEntry[];
  statusHistory: AppointmentStatusHistoryEntry[];
  rescheduleHistory: RescheduleHistoryEntry[];
}

/**
 * Legal status transitions, mirrored from
 * `server/src/modules/appointments/lifecycle.service.ts`.
 *
 * Duplicated here so the UI can hide an action the API would refuse, rather
 * than offering a button whose only outcome is a 409. The server remains the
 * authority — this is a courtesy, not a check.
 */
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  PENDING: ['CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'REJECTED'],
  CONFIRMED: ['RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  RESCHEDULED: ['RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  REJECTED: [],
} as const;

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Weekly windows are stored as minutes from local midnight. An `endMinute`
 * above 1440 is an overnight window (22:00–02:00 is 1320–1560).
 */
export interface BusinessHours {
  id: string;
  locationId: string | null;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  isActive: boolean;
}

export interface StaffAvailabilityRule {
  id: string;
  staffProfileId: string;
  locationId: string | null;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
}

export const OVERRIDE_SCOPES = ['BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE'] as const;
export type OverrideScope = (typeof OVERRIDE_SCOPES)[number];

export const OVERRIDE_REASONS = [
  'LEAVE',
  'SICK',
  'TRAINING',
  'HOLIDAY',
  'EXTRA_HOURS',
  'CUSTOM',
] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

export interface AvailabilityOverride {
  id: string;
  scope: OverrideScope;
  staffProfileId: string | null;
  locationId: string | null;
  resourceId: string | null;
  /** A calendar date in the workspace zone, not an instant. */
  date: string;
  /** false removes time the recurring rules offer; true adds a window. */
  isAvailable: boolean;
  startMinute: number | null;
  endMinute: number | null;
  reason: OverrideReason | null;
  note: string | null;
  createdAt: string;
}

export interface Holiday {
  id: string;
  locationId: string | null;
  name: string;
  date: string;
  isRecurringAnnually: boolean;
  closesBusiness: boolean;
  isActive: boolean;
}

export const BLACKOUT_SCOPES = ['BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE'] as const;
export type BlackoutScope = (typeof BLACKOUT_SCOPES)[number];

export interface BlackoutPeriod {
  id: string;
  scope: BlackoutScope;
  staffProfileId: string | null;
  locationId: string | null;
  resourceId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue, people and structure — the shapes with nested rows
// ---------------------------------------------------------------------------

/** Sequelize surfaces the join row under the through-model's name. */
export interface ServiceStaffLink {
  durationMinutesOverride: number | null;
  priceAmountOverride: number | null;
  priority: number;
  weight: number;
  isActive: boolean;
}

export type StaffSummary = Pick<
  StaffProfile,
  'id' | 'displayName' | 'title' | 'avatarUrl' | 'color' | 'timezone' | 'isBookable' | 'isActive'
>;

/** `GET /services/:id` — the list shape plus its assignments. */
export interface ServiceDetail extends Service {
  staff: Array<StaffSummary & { ServiceStaff: ServiceStaffLink }>;
  locations: Array<Pick<Location, 'id' | 'name' | 'slug' | 'type' | 'timezone' | 'isActive'>>;
}

/** `GET /staff/:id/services`. */
export interface StaffServiceLink {
  id: string;
  serviceId: string;
  staffProfileId: string;
  durationMinutesOverride: number | null;
  priceAmountOverride: number | null;
  priority: number;
  weight: number;
  isActive: boolean;
  service: Pick<
    Service,
    'id' | 'name' | 'slug' | 'durationMinutes' | 'priceAmount' | 'currency'
  > & {
    isActive: boolean;
  };
}

export interface TeamMember {
  id: string;
  teamId: string;
  staffProfileId: string;
  weight: number;
  priority: number;
  isActive: boolean;
  staffProfile: StaffSummary;
}

/** `GET /teams/:id`. */
export interface TeamDetail extends Team {
  members: TeamMember[];
}

/** `GET /resources/requirements/service/:serviceId`. */
export interface ServiceResourceRequirement {
  id: string;
  serviceId: string;
  resourceId: string | null;
  resourceType: ResourceType | null;
  quantity: number;
  isRequired: boolean;
  resource: {
    id: string;
    name: string;
    slug: string;
    type: ResourceType;
    capacity: number;
    color: string | null;
    locationId: string | null;
    isActive: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** `GET /customers/:id/appointments` — a slimmer row than the diary's. */
/**
 * `GET /customers/:id`.
 *
 * The record is wrapped rather than returned bare: the endpoint answers with
 * the customer *and* a short tail of their bookings, so a detail view has
 * something to show before the paginated history arrives.
 */
export interface CustomerDetail {
  customer: Customer;
  recentAppointments: CustomerAppointment[];
}

export interface CustomerAppointment {
  id: string;
  publicId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timezone: string;
  priceAmount: number;
  currency: string;
  source: AppointmentSource;
  cancelledAt: string | null;
  cancellationReason: string | null;
  service: Pick<Service, 'id' | 'name' | 'slug' | 'durationMinutes'> | null;
  staffProfile: { id: string; displayName: string } | null;
  location: { id: string; name: string; timezone: string } | null;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

/** The list row carries more joins than the base `WaitlistEntry` declares. */
export interface WaitlistRow {
  staffProfile: { id: string; displayName: string } | null;
  location: { id: string; name: string; timezone: string } | null;
  convertedAppointment: {
    id: string;
    publicId: string;
    status: AppointmentStatus;
    startsAt: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Availability search (used when rescheduling)
// ---------------------------------------------------------------------------

export interface AvailableSlot {
  startsAt: string;
  endsAt: string;
  staffProfileId: string;
  staffName: string;
  locationId: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  remainingCapacity?: number;
}

export interface AvailabilitySearchResult {
  slots: AvailableSlot[];
  timezone: string;
  truncated: boolean;
  policy: {
    durationMinutes: number;
    slotIntervalMinutes: number;
    minNoticeMinutes: number;
    maxHorizonDays: number;
    capacity: number;
    requiresApproval: boolean;
    priceAmount: number;
    currency: string;
  };
}

/** `AssignmentStrategy` is shared by services and teams; re-exported for forms. */
export type { AssignmentStrategy };
