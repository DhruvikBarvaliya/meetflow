/**
 * The customer portal: a person's own bookings, across every workspace at once.
 *
 * MeetFlow has four workspace roles and a customer, but only the four roles are
 * *memberships*. A customer is not a member of anything — they are a person who
 * happens to appear in one or more workspaces' address books. `Customer.userId`
 * is the whole design: sign in as a `User`, and the `Customer` rows pointing at
 * you are, collectively, you.
 *
 * Three invariants hold everything here together.
 *
 *  1. **The scope is `Customer.userId = <the signed-in user>`, and nothing
 *     else.** There is no tenant header on this surface, no workspace id in any
 *     schema, and no code path that accepts one. Every query in this file is
 *     filtered by the set of customer ids resolved from the token — which is
 *     why that filter is written into the WHERE clause of the query that
 *     fetches the row, never applied as a check afterwards. A booking that is
 *     not theirs is indistinguishable from one that does not exist: 404, never
 *     403.
 *
 *  2. **Changes go through the one lifecycle service.** Cancel and reschedule
 *     here are the same calls the public manage-link and the staff calendar
 *     make. The cancellation deadline, the audit row, the withdrawal of queued
 *     reminders and the waitlist trigger all live there; a second cancellation
 *     path would be a second place for those to be forgotten.
 *
 *  3. **The person is a customer, even when they are also an owner.** Every
 *     lifecycle call from this file passes `enforceCustomerPolicy: true`. A
 *     workspace owner who books with their own business gets the customer's
 *     deadline here and must use the staff surface to override it — otherwise
 *     the portal would quietly become a policy bypass for anybody who happens
 *     to hold a membership somewhere.
 *
 * What the customer may see is bounded by the anonymous booking surface rather
 * than by this file's own judgement: the detail view is literally
 * `getPublicAppointment`. That serialiser already decided which fields survive
 * contact with a customer — no internal notes, no other attendee, no room link
 * once the booking is dead — and reusing it means the two surfaces cannot drift
 * into disagreeing about what a customer is allowed to know.
 */
import { Op } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  Business,
  Customer,
  Location,
  Service,
  StaffProfile,
  User,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { LocationType } from '../../database/models/Location';
import { ConflictError, NotFoundError, UnauthenticatedError } from '../../utils/errors';
import {
  cancelAppointment,
  rescheduleAppointment,
  type LifecycleActor,
} from '../appointments/lifecycle.service';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  getPublicAppointment,
  type PublicAppointmentView,
} from '../publicBooking/publicBooking.service';
import type {
  CancelBookingBody,
  ListBookingsQuery,
  RescheduleBookingBody,
  UpdatePreferencesBody,
} from './portal.validation';

const log = createLogger('customer-portal');

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

/**
 * A workspace as its customer sees it.
 *
 * Exactly the fields the anonymous booking page publishes, and deliberately no
 * workspace id: the portal addresses everything by opaque handle, so an
 * internal uuid would be the one identifier a client could start sending back.
 */
export interface PortalWorkspaceSummary {
  /** The `cus_…` handle for this person's record in that workspace. */
  customerPublicId: string;
  business: {
    name: string;
    logoUrl: string | null;
    timezone: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  /** When this workspace first had a record of them. */
  knownSince: Date;
  upcomingBookings: number;
}

export interface PortalProfile {
  user: Record<string, unknown>;
  workspaces: PortalWorkspaceSummary[];
  /** Live bookings across every workspace — the dashboard's headline figure. */
  upcomingBookings: number;
}

/**
 * One row of the booking list.
 *
 * Lighter than the detail view on purpose: a list needs enough to render a card
 * and decide what to open, and every extra column is one more join across what
 * may be a dozen workspaces. The full record — answers, notes, policy, the room
 * link — is one request away at `/me/bookings/:publicId`.
 */
export interface PortalBookingSummary {
  publicId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  timezone: string;
  priceAmount: number;
  currency: string;
  title: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  rescheduleCount: number;
  business: { name: string; logoUrl: string | null; timezone: string };
  service: { name: string; durationMinutes: number } | null;
  staff: { displayName: string; avatarUrl: string | null } | null;
  location: { name: string; type: LocationType; timezone: string } | null;
}

export interface PortalBookingPage {
  rows: PortalBookingSummary[];
  totalItems: number;
}

export interface PortalPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  marketingOptIn: boolean;
  /** Null means "follow each workspace's own reminder schedule". */
  reminderOffsetsMinutes: number[] | null;
}

export interface PortalPreferencesView {
  preferences: PortalPreferences;
  /**
   * True when the linked workspaces do not all hold the same answer.
   *
   * They can: staff edit the same JSON column from the address book. When they
   * disagree there is no honest single value, so the reported one is the
   * conservative reading and this flag tells the client to say "varies" rather
   * than presenting one workspace's answer as though it were universal.
   */
  divergent: boolean;
  workspaceCount: number;
}

// ---------------------------------------------------------------------------
// Identity: which Customer rows are this person?
// ---------------------------------------------------------------------------

/**
 * The set of customer records belonging to the signed-in person.
 *
 * Resolved once per request and threaded through every function below, so the
 * scope is computed in exactly one place and cannot be widened by a caller.
 */
export interface PortalScope {
  user: User;
  customers: Customer[];
  customerIds: string[];
}

/**
 * Links unlinked `Customer` rows to the signed-in account by email address.
 *
 * **The decision, and the reasoning.** Linking on a bare email match is an
 * account-takeover primitive: registration accepts any address, so if a match
 * alone were enough, anyone could type a stranger's address, sign in, and read
 * that stranger's entire booking history — every business they use, every
 * appointment, every time and place they will be at. That is a serious breach
 * assembled out of one guessable string.
 *
 * So linking is gated on `emailVerifiedAt`, which registration deliberately
 * leaves null. Once that gate is passed, automatic linking is not merely safe
 * but *correct*: the confirmation for every one of those appointments was
 * delivered to that mailbox carrying the `apt_…` manage link, which already
 * permits reading, moving and cancelling the booking without any account at
 * all. Somebody who has proven control of the mailbox therefore gains nothing
 * here they could not already do by opening their email — the portal only makes
 * it convenient. An additional per-workspace confirmation step would protect
 * nothing while stranding every customer in the empty state the README already
 * describes wrongly.
 *
 * Two narrower rules follow from the same reasoning:
 *  - only rows with `userId IS NULL` are ever touched. A row already pointing
 *    at somebody else is somebody else's, and one person changing their address
 *    must never reassign another person's record;
 *  - the rows are locked for the duration, so two concurrent sign-ins cannot
 *    both conclude they are the first to link.
 *
 * Reconciliation runs on read rather than at registration because verification
 * routinely happens long after sign-up, and because the customer row often does
 * not exist yet when the account does — someone books with a business a year
 * after joining, and that booking must find its way to their portal too.
 */
async function linkCustomerRecords(user: User): Promise<number> {
  if (user.emailVerifiedAt === null) return 0;

  // Cheap unlocked probe first. Reconciliation runs on every portal request but
  // has something to do on almost none of them, and an indexed count is far
  // less than a transaction plus a row lock. It is deliberately not
  // authoritative — the locked read inside the transaction settles the race.
  const pending = await Customer.count({ where: { email: user.email, userId: null } });
  if (pending === 0) return 0;

  return sequelize.transaction(async (transaction) => {
    const orphans = await Customer.findAll({
      // `email` is CITEXT, so this equality is case-insensitive in the database
      // exactly as it is at the validation boundary.
      where: { email: user.email, userId: null },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (orphans.length === 0) return 0;

    for (const customer of orphans) {
      await customer.update({ userId: user.id }, { transaction });

      // Written in the same transaction as the link, and attributed to the
      // workspace whose record was touched — an audit row belongs to the tenant
      // whose data changed, not to the person who caused it. No email address
      // reaches the metadata: audit rows outlive the record they describe,
      // including one deleted precisely because the person asked.
      await recordAudit(
        {
          businessId: customer.businessId,
          actorType: 'CUSTOMER',
          actorUserId: user.id,
          actorCustomerId: customer.id,
          action: AuditActions.CUSTOMER_UPDATED,
          entityType: 'customer',
          entityId: customer.id,
          metadata: {
            via: 'customer_portal',
            linkedToUserId: user.id,
            reason: 'verified_email_match',
          },
        },
        { transaction },
      );
    }

    log.info({ userId: user.id, linked: orphans.length }, 'linked customer records to account');
    return orphans.length;
  });
}

/**
 * Resolves who is asking, and which customer records are theirs.
 *
 * The `Business` include is `required: true`, so a workspace that has been
 * deleted takes its customer record — and therefore its bookings — with it,
 * matching what the anonymous surface does with a handle for a workspace that
 * has gone. A *suspended* workspace is deliberately not filtered out: its
 * customers still hold real appointments there, and making those vanish without
 * explanation would serve the person worse than showing them.
 */
export async function resolveScope(userId: string): Promise<PortalScope> {
  const user = await User.findByPk(userId);
  // `authenticate` proved this row existed moments ago; if it has gone since,
  // the session is no longer answerable and the caller must sign in again.
  if (!user) throw new UnauthenticatedError('This account no longer exists.');

  await linkCustomerRecords(user);

  const customers = await Customer.findAll({
    where: { userId: user.id },
    include: [{ model: Business, as: 'business', required: true }],
    order: [['createdAt', 'ASC']],
  });

  return { user, customers, customerIds: customers.map((customer) => customer.id) };
}

/** The actor recorded against anything this person changes. */
function actorOf(scope: PortalScope, customerId: string | null): LifecycleActor {
  return {
    type: 'CUSTOMER',
    // The improvement over the anonymous surface, in one field: this change is
    // attributable to an account rather than to "whoever held the link".
    userId: scope.user.id,
    customerId,
    label: scope.user.email,
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile(scope: PortalScope): Promise<PortalProfile> {
  const upcomingByCustomer = await countUpcomingByCustomer(scope.customerIds);

  const workspaces = scope.customers.map((customer) => {
    const business = customer.get('business') as Business;
    return {
      customerPublicId: customer.publicId,
      business: {
        name: business.name,
        logoUrl: business.logoUrl,
        timezone: business.timezone,
        supportEmail: business.supportEmail,
        supportPhone: business.supportPhone,
      },
      knownSince: customer.createdAt,
      upcomingBookings: upcomingByCustomer.get(customer.id) ?? 0,
    };
  });

  return {
    // The model's own serialiser, which omits every secret column by
    // construction rather than by deletion.
    user: scope.user.toPublicJSON(),
    workspaces,
    upcomingBookings: workspaces.reduce((total, row) => total + row.upcomingBookings, 0),
  };
}

/**
 * Upcoming bookings per customer record.
 *
 * Tallied in JavaScript from a list of ids rather than with a grouped COUNT:
 * one person's live bookings number in the tens at most, and reading the ids
 * keeps the result exactly typed instead of casting through the loose shape a
 * grouped aggregate comes back as.
 */
async function countUpcomingByCustomer(customerIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (customerIds.length === 0) return counts;

  const rows = await Appointment.findAll({
    attributes: ['customerId'],
    where: {
      customerId: { [Op.in]: customerIds },
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      startsAt: { [Op.gte]: new Date() },
    },
  });

  for (const row of rows) {
    if (!row.customerId) continue;
    counts.set(row.customerId, (counts.get(row.customerId) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

const BUSINESS_ATTRIBUTES = ['id', 'name', 'logoUrl', 'timezone'] as const;
const SERVICE_ATTRIBUTES = ['id', 'name', 'durationMinutes'] as const;
const STAFF_ATTRIBUTES = ['id', 'displayName', 'avatarUrl'] as const;
const LOCATION_ATTRIBUTES = ['id', 'name', 'type', 'timezone'] as const;

function toBookingSummary(appointment: Appointment): PortalBookingSummary {
  const business = appointment.get('business') as Business;
  const service = appointment.get('service') as Service | undefined;
  const staffProfile = appointment.get('staffProfile') as StaffProfile | undefined;
  const location = appointment.get('location') as Location | undefined;

  return {
    publicId: appointment.publicId,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    durationMinutes: appointment.durationMinutes,
    timezone: appointment.timezone,
    priceAmount: appointment.priceAmount,
    currency: appointment.currency,
    title: appointment.title,
    cancelledAt: appointment.cancelledAt,
    cancellationReason: appointment.cancellationReason,
    rescheduleCount: appointment.rescheduleCount,
    business: { name: business.name, logoUrl: business.logoUrl, timezone: business.timezone },
    // `internalNotes` is absent here and from every other shape this file
    // returns: staff commentary about a person is written for the workspace,
    // not for them.
    service: service ? { name: service.name, durationMinutes: service.durationMinutes } : null,
    staff: staffProfile
      ? { displayName: staffProfile.displayName, avatarUrl: staffProfile.avatarUrl }
      : null,
    location: location
      ? { name: location.name, type: location.type, timezone: location.timezone }
      : null,
  };
}

/**
 * Every booking this person holds, across every workspace: newest first, or
 * soonest first when they asked for what is coming up, because those are two
 * different questions and they want opposite orders.
 *
 * `when` is purely temporal. A cancelled appointment next Tuesday is still
 * upcoming, and hiding it would leave the person wondering what became of it;
 * filtering by outcome is what `status` is for.
 *
 * Scope note: this lists appointments the person *booked*. A place held on
 * somebody else's group session lives in `appointment_participants` and is not
 * an appointment of theirs — the lifecycle service has a `participantId` path
 * for releasing one such place, and surfacing those is a separate decision for
 * the client wave to ask for rather than one smuggled in behind this list.
 */
export async function listBookings(
  scope: PortalScope,
  query: ListBookingsQuery,
): Promise<PortalBookingPage> {
  if (scope.customerIds.length === 0) return { rows: [], totalItems: 0 };

  const now = new Date();
  const ascending = query.when === 'UPCOMING';

  const { rows, count } = await Appointment.findAndCountAll({
    where: {
      // The scope filter is part of the query, not a test applied to its
      // results. There is no ordering of statements in which this file reads a
      // booking and then decides not to return it.
      customerId: { [Op.in]: scope.customerIds },
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.when === 'UPCOMING' ? { startsAt: { [Op.gte]: now } } : {}),
      ...(query.when === 'PAST' ? { startsAt: { [Op.lt]: now } } : {}),
    },
    include: [
      // Required: a deleted workspace takes its appointments with it, the same
      // way it takes the customer record in `resolveScope`.
      { model: Business, as: 'business', required: true, attributes: [...BUSINESS_ATTRIBUTES] },
      { model: Service, as: 'service', attributes: [...SERVICE_ATTRIBUTES] },
      { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
      { model: Location, as: 'location', attributes: [...LOCATION_ATTRIBUTES] },
    ],
    // `id` last gives the sort a total order: without it two bookings starting
    // in the same minute can swap places between pages, and one of them is
    // never shown.
    order: ascending
      ? [
          ['startsAt', 'ASC'],
          ['id', 'ASC'],
        ]
      : [
          ['startsAt', 'DESC'],
          ['id', 'DESC'],
        ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows: rows.map(toBookingSummary), totalItems: count };
}

/**
 * The one place a booking is loaded by its handle.
 *
 * Both conditions sit in the same WHERE clause on purpose. A handle belonging
 * to another person and a handle belonging to nobody produce the same miss, so
 * this endpoint cannot be used to discover whether an `apt_…` reference is real
 * — and no later edit can accidentally demote the ownership test into a check
 * that runs once the row is already in hand.
 */
async function loadOwnedBooking(scope: PortalScope, publicId: string): Promise<Appointment> {
  if (scope.customerIds.length === 0) throw new NotFoundError('Booking');

  const appointment = await Appointment.findOne({
    where: { publicId, customerId: { [Op.in]: scope.customerIds } },
  });
  if (!appointment) throw new NotFoundError('Booking');
  return appointment;
}

/**
 * One booking in full.
 *
 * The serialiser is the anonymous surface's, reused rather than reimplemented:
 * it has already decided what a customer may see, and a second copy of those
 * decisions would be a second place for them to rot.
 */
export async function getBooking(
  scope: PortalScope,
  publicId: string,
): Promise<PublicAppointmentView> {
  const appointment = await loadOwnedBooking(scope, publicId);
  return getPublicAppointment(appointment.publicId);
}

export async function cancelBooking(
  scope: PortalScope,
  publicId: string,
  input: CancelBookingBody,
  metadata: RequestMetadata,
): Promise<PublicAppointmentView> {
  const appointment = await loadOwnedBooking(scope, publicId);

  const cancelled = await cancelAppointment({
    // Taken off the appointment row, which was itself reached only through this
    // person's own customer ids. The workspace is never named by the client.
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    reason: input.reason ?? null,
    actor: actorOf(scope, appointment.customerId),
    metadata,
    enforceCustomerPolicy: true,
  });

  return getPublicAppointment(cancelled.publicId);
}

export async function rescheduleBooking(
  scope: PortalScope,
  publicId: string,
  input: RescheduleBookingBody,
  metadata: RequestMetadata,
): Promise<PublicAppointmentView> {
  const appointment = await loadOwnedBooking(scope, publicId);

  const moved = await rescheduleAppointment({
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    newStartsAt: input.startsAt,
    reason: input.reason ?? null,
    actor: actorOf(scope, appointment.customerId),
    metadata,
    enforceCustomerPolicy: true,
  });

  return getPublicAppointment(moved.publicId);
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

/**
 * Preferences are stored per workspace, on each `Customer` row, and the portal
 * presents them as one set belonging to the person.
 *
 * That is a decision rather than an accident of the schema. The alternative — a
 * workspace picker on the preferences screen — would require the client to name
 * a workspace in the request, which is precisely the identifier this surface
 * must never accept. It would also be the wrong product: somebody who no longer
 * wants reminder emails wants them to stop, not to be switched off four times.
 * Per-workspace divergence stays possible because staff can still edit one
 * record from the address book, so reads report it rather than pretending it
 * cannot happen.
 */
const PREFERENCE_DEFAULTS: PortalPreferences = {
  // Mirrors the column default on `customers.communication_preferences`.
  emailEnabled: true,
  smsEnabled: false,
  marketingOptIn: false,
  reminderOffsetsMinutes: null,
};

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Absent, malformed or empty all mean "this workspace's own schedule applies". */
function readOffsets(raw: Record<string, unknown>): number[] | null {
  const value = raw.reminderOffsetsMinutes;
  if (!Array.isArray(value)) return null;
  const offsets = value.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item) && item > 0,
  );
  return offsets.length > 0 ? offsets : null;
}

function readPreferences(customer: Customer): PortalPreferences {
  const raw = customer.communicationPreferences;
  return {
    emailEnabled: readBoolean(raw, 'emailEnabled', PREFERENCE_DEFAULTS.emailEnabled),
    smsEnabled: readBoolean(raw, 'smsEnabled', PREFERENCE_DEFAULTS.smsEnabled),
    marketingOptIn: readBoolean(raw, 'marketingOptIn', PREFERENCE_DEFAULTS.marketingOptIn),
    reminderOffsetsMinutes: readOffsets(raw),
  };
}

function sameOffsets(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Folds one set of preferences out of several workspaces' worth.
 *
 * Where they disagree the reported answer is the conservative one — a switch
 * shown as on while it is off somewhere would promise the person something that
 * will not happen — and `divergent` says so, so the client can label it instead
 * of silently crowning a winner.
 */
function foldPreferences(customers: Customer[]): PortalPreferencesView {
  // Destructured rather than indexed so the empty case is handled by the type
  // system: with no linked workspace there is nothing to fold, and the column
  // defaults are the honest answer.
  const [head, ...tail] = customers;
  if (!head) {
    return { preferences: { ...PREFERENCE_DEFAULTS }, divergent: false, workspaceCount: 0 };
  }

  const first = readPreferences(head);
  const all = [first, ...tail.map(readPreferences)];

  const divergent = all.some(
    (entry) =>
      entry.emailEnabled !== first.emailEnabled ||
      entry.smsEnabled !== first.smsEnabled ||
      entry.marketingOptIn !== first.marketingOptIn ||
      !sameOffsets(entry.reminderOffsetsMinutes, first.reminderOffsetsMinutes),
  );

  return {
    preferences: {
      emailEnabled: all.every((entry) => entry.emailEnabled),
      smsEnabled: all.every((entry) => entry.smsEnabled),
      marketingOptIn: all.every((entry) => entry.marketingOptIn),
      reminderOffsetsMinutes: divergent ? null : first.reminderOffsetsMinutes,
    },
    divergent,
    workspaceCount: customers.length,
  };
}

export function getPreferences(scope: PortalScope): PortalPreferencesView {
  return foldPreferences(scope.customers);
}

export async function updatePreferences(
  scope: PortalScope,
  input: UpdatePreferencesBody,
  metadata: RequestMetadata,
): Promise<PortalPreferencesView> {
  if (scope.customers.length === 0) {
    // Answering 200 to a write that stored nothing would be a lie the client
    // has no way to detect: the switch would spring back on the next load.
    throw new ConflictError(
      'There is nowhere to store these preferences yet. They are kept against your record with each business, which exists once you have booked with one.',
    );
  }

  const updated = await sequelize.transaction(async (transaction) => {
    const rows: Customer[] = [];

    for (const customer of scope.customers) {
      const merged: Record<string, unknown> = { ...customer.communicationPreferences };

      if (input.emailEnabled !== undefined) merged.emailEnabled = input.emailEnabled;
      if (input.smsEnabled !== undefined) merged.smsEnabled = input.smsEnabled;
      if (input.marketingOptIn !== undefined) merged.marketingOptIn = input.marketingOptIn;
      if (input.reminderOffsetsMinutes !== undefined) {
        if (input.reminderOffsetsMinutes === null) {
          // Deleted rather than stored as null: absence is what the reminder
          // scheduler reads as "use the workspace's schedule", and a null left
          // in the object would be one more shape every consumer has to handle.
          delete merged.reminderOffsetsMinutes;
        } else {
          merged.reminderOffsetsMinutes = input.reminderOffsetsMinutes;
        }
      }

      await customer.update({ communicationPreferences: merged }, { transaction });

      // One audit row per workspace, in the same transaction as the change it
      // describes. Consent is exactly the kind of decision a business has to be
      // able to evidence later, so the new values are recorded and not merely
      // the fact that something moved.
      await recordAudit(
        {
          businessId: customer.businessId,
          actorType: 'CUSTOMER',
          actorUserId: scope.user.id,
          actorCustomerId: customer.id,
          action: AuditActions.CUSTOMER_UPDATED,
          entityType: 'customer',
          entityId: customer.id,
          requestId: metadata.requestId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          metadata: { via: 'customer_portal', communicationPreferences: { ...input } },
        },
        { transaction },
      );

      rows.push(customer);
    }

    return rows;
  });

  return foldPreferences(updated);
}
