'use strict';

/**
 * A complete demo tenant: "Aurora Wellness Studio" (Asia/Kolkata, INR).
 *
 * The point of this seed is that every part of the product has something real
 * to show — a diary with history *and* a future, group classes, buffers,
 * resources, leave, waitlists, notifications in every state — without a single
 * row that the schema would not have accepted from the API itself.
 *
 * Three rules shape the implementation:
 *
 * 1. **Determinism.** Every primary key is a fixed uuid built from a per-table
 *    prefix and an index (see `id()`), so re-running produces exactly the same
 *    graph and `down()` can name precisely what `up()` created. Only the
 *    *instants* move: appointments are anchored to the Monday of the current
 *    week so the demo always straddles "now".
 *
 * 2. **No constraint may be discovered by the database.** `appointment_staff`
 *    carries a GiST exclusion constraint (one staff member, no two overlapping
 *    blocking reservations) and `appointment_resources` carries another. The
 *    buffered windows are computed here and then *verified* here — see
 *    `assertNoOverlaps()` — so a scheduling mistake in this file fails with a
 *    readable message instead of a 23P01 from Postgres.
 *
 * 3. **Nothing is invented at insert time.** Customer counters, booking-link
 *    counters, participant totals and status history are all derived from the
 *    one appointment plan below, so the demo data is internally consistent.
 */

const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Values accepted as "yes" for SEED_ENABLED, matching sequelize-cli.config.cjs. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Seeding writes demo credentials and a demo tenant, and `down()` deletes them
 * again. Requiring an explicit opt-in makes it impossible to run either half by
 * reflex against a database that holds real data.
 */
function assertSeedEnabled() {
  const flag = String(process.env.SEED_ENABLED ?? '')
    .trim()
    .toLowerCase();
  if (!TRUTHY.has(flag)) {
    throw new Error(
      'Refusing to seed the demo workspace: SEED_ENABLED is not set to a truthy ' +
        "value (one of '1', 'true', 'yes', 'on'). Set SEED_ENABLED=true to run the seeders.",
    );
  }
}

const DEFAULT_PASSWORD = 'MeetFlow!Demo123';
/** Same cost factor as src/utils/password.ts, so demo logins behave identically. */
const BCRYPT_COST = 12;

// ---------------------------------------------------------------------------
// Fixed identifiers
//
// One prefix per table keeps the ids readable in a psql session ("70…" is an
// appointment) and guarantees uniqueness across tables without a generator.
// ---------------------------------------------------------------------------

const id = (prefix, index) => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;

const BUSINESS = id('20000000', 1);

const U_ADMIN = id('10000000', 1);
const U_OWNER = id('10000000', 2);
const U_RAHUL = id('10000000', 3);
const U_ANANYA = id('10000000', 4);
const U_VIKRAM = id('10000000', 5);
const U_NEHA = id('10000000', 11);
const U_ARJUN = id('10000000', 12);
const U_FATIMA = id('10000000', 13);
const U_DANIEL = id('10000000', 14);

const R_OWNER = id('21000000', 1);
const R_MANAGER = id('21000000', 2);
const R_RECEPTIONIST = id('21000000', 3);
const R_STAFF = id('21000000', 4);

const M_OWNER = id('22000000', 1);
const M_RAHUL = id('22000000', 2);
const M_ANANYA = id('22000000', 3);
const M_VIKRAM = id('22000000', 4);
const M_ADMIN = id('22000000', 5);

const L_INDIRANAGAR = id('30000000', 1);
const L_KORAMANGALA = id('30000000', 2);

const T_THERAPY = id('31000000', 1);
const T_MOVEMENT = id('31000000', 2);

const SP_RAHUL = id('32000000', 1);
const SP_ANANYA = id('32000000', 2);
const SP_VIKRAM = id('32000000', 3);

const CAT_MASSAGE = id('40000000', 1);
const CAT_SKIN = id('40000000', 2);
const CAT_MOVEMENT = id('40000000', 3);

const SVC_DEEP = id('41000000', 1);
const SVC_SWEDISH = id('41000000', 2);
const SVC_FACIAL = id('41000000', 3);
const SVC_PHYSIO = id('41000000', 4);
const SVC_YOGA = id('41000000', 5);
const SVC_CONSULT = id('41000000', 6);

const RES_ROOM_A = id('44000000', 1);
const RES_ROOM_B = id('44000000', 2);
const RES_RIG = id('44000000', 3);
const RES_DESK = id('44000000', 4);

const C_NEHA = id('60000000', 1);
const C_ARJUN = id('60000000', 2);
const C_FATIMA = id('60000000', 3);
const C_DANIEL = id('60000000', 4);

const BL_YOGA = id('61000000', 1);
const BL_CATALOG = id('61000000', 2);

const W_FATIMA = id('76000000', 1);
const W_DANIEL = id('76000000', 2);
const W_ARJUN = id('76000000', 3);

// ---------------------------------------------------------------------------
// Time
//
// Asia/Kolkata is UTC+05:30 and observes no DST, so a fixed offset is exact
// here. Everything is expressed as "minutes from local midnight" on a weekday
// of a week relative to the current one, which keeps the demo diary on real
// working days no matter which day the seed is run.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IST_OFFSET_MINUTES = 330;

const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;
const SAT = 5;

function buildTimeline(now) {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(utcMidnight).getUTCDay(); // 0 = Sunday
  const monday = utcMidnight - ((weekday + 6) % 7) * DAY_MS;

  return {
    now,
    /** Instant of `localMinute` on `dayIndex` of week `weekOffset`, studio time. */
    at(weekOffset, dayIndex, localMinute) {
      return new Date(
        monday +
          (weekOffset * 7 + dayIndex) * DAY_MS +
          (localMinute - IST_OFFSET_MINUTES) * MINUTE_MS,
      );
    },
    /** The studio's calendar date (YYYY-MM-DD) for that same day. */
    date(weekOffset, dayIndex) {
      return new Date(monday + (weekOffset * 7 + dayIndex) * DAY_MS).toISOString().slice(0, 10);
    },
  };
}

const minutesAfter = (date, minutes) => new Date(date.getTime() + minutes * MINUTE_MS);
const daysBefore = (date, days) => new Date(date.getTime() - days * DAY_MS);

/**
 * Clamps an instant to the past.
 *
 * "Cancelled four days before it was due" is only meaningful for an appointment
 * that has already happened; for one three weeks out it would claim the studio
 * acted in the future. Anything that records something a person *did* goes
 * through here.
 */
const alreadyHappened = (date, now) =>
  new Date(Math.min(date.getTime(), now.getTime() - 60 * MINUTE_MS));

// ---------------------------------------------------------------------------
// Reference data used by the builders below
// ---------------------------------------------------------------------------

const PEOPLE = {
  ADMIN: { userId: U_ADMIN, name: 'Aarav Krishnan', email: 'admin@meetflow.dev' },
  OWNER: { userId: U_OWNER, name: 'Priya Shah', email: 'priya.shah@aurorawellness.test' },
  RAHUL: { userId: U_RAHUL, name: 'Rahul Menon', email: 'rahul.menon@aurorawellness.test' },
  ANANYA: { userId: U_ANANYA, name: 'Ananya Iyer', email: 'ananya.iyer@aurorawellness.test' },
  VIKRAM: { userId: U_VIKRAM, name: 'Vikram Desai', email: 'vikram.desai@aurorawellness.test' },
};

const STAFF = {
  RAHUL: { profileId: SP_RAHUL, ...PEOPLE.RAHUL },
  ANANYA: { profileId: SP_ANANYA, ...PEOPLE.ANANYA },
  VIKRAM: { profileId: SP_VIKRAM, ...PEOPLE.VIKRAM },
};

const CUSTOMERS = {
  NEHA: {
    id: C_NEHA,
    userId: U_NEHA,
    publicId: `cus_DEM0${String(1).padStart(22, '0')}`,
    firstName: 'Neha',
    lastName: 'Kapoor',
    email: 'neha.kapoor@example.com',
    phone: '+919845010001',
  },
  ARJUN: {
    id: C_ARJUN,
    userId: U_ARJUN,
    publicId: `cus_DEM0${String(2).padStart(22, '0')}`,
    firstName: 'Arjun',
    lastName: 'Rao',
    email: 'arjun.rao@example.com',
    phone: '+919845010002',
  },
  FATIMA: {
    id: C_FATIMA,
    userId: U_FATIMA,
    publicId: `cus_DEM0${String(3).padStart(22, '0')}`,
    firstName: 'Fatima',
    lastName: 'Sheikh',
    email: 'fatima.sheikh@example.com',
    phone: '+919845010003',
  },
  DANIEL: {
    id: C_DANIEL,
    userId: U_DANIEL,
    publicId: `cus_DEM0${String(4).padStart(22, '0')}`,
    firstName: 'Daniel',
    lastName: 'Fernandes',
    email: 'daniel.fernandes@example.com',
    phone: '+919845010004',
  },
};

/** Workspace defaults; a service with a NULL buffer inherits these. */
const DEFAULT_PRE_BUFFER = 0;
const DEFAULT_POST_BUFFER = 10;
const NO_SHOW_GRACE_MINUTES = 15;

/**
 * `preBuffer` / `postBuffer` mirror the nullable service columns: null means
 * "inherit from business_settings", which is what the booking engine does.
 */
const SERVICES = {
  DEEP: {
    id: SVC_DEEP,
    duration: 90,
    preBuffer: 15,
    postBuffer: 15,
    price: 350000,
    capacity: 1,
    team: T_THERAPY,
    requiresApproval: false,
    resources: [{ resourceId: RES_ROOM_A, exclusive: true }],
  },
  SWEDISH: {
    id: SVC_SWEDISH,
    duration: 60,
    preBuffer: null,
    postBuffer: null,
    price: 250000,
    capacity: 1,
    team: T_THERAPY,
    requiresApproval: false,
    resources: [],
  },
  FACIAL: {
    id: SVC_FACIAL,
    duration: 45,
    preBuffer: null,
    postBuffer: null,
    price: 180000,
    capacity: 1,
    team: null,
    requiresApproval: false,
    resources: [{ resourceId: RES_ROOM_A, exclusive: true }],
  },
  PHYSIO: {
    id: SVC_PHYSIO,
    duration: 30,
    preBuffer: null,
    postBuffer: null,
    price: 150000,
    capacity: 1,
    team: T_MOVEMENT,
    requiresApproval: false,
    resources: [{ resourceId: RES_RIG, exclusive: true }],
  },
  YOGA: {
    id: SVC_YOGA,
    duration: 60,
    preBuffer: null,
    postBuffer: null,
    price: 60000,
    capacity: 12,
    team: T_MOVEMENT,
    requiresApproval: false,
    resources: [],
  },
  CONSULT: {
    id: SVC_CONSULT,
    duration: 30,
    preBuffer: null,
    postBuffer: null,
    price: 0,
    capacity: 1,
    team: null,
    requiresApproval: true,
    // The consult pod seats two, so its reservation is counted rather than
    // excluded — is_exclusive false keeps it out of the overlap constraint.
    resources: [{ resourceId: RES_DESK, exclusive: false }],
  },
};

const LOCATIONS = { INDIRANAGAR: L_INDIRANAGAR, KORAMANGALA: L_KORAMANGALA };
const LINKS = { YOGA: BL_YOGA, CATALOG: BL_CATALOG };

const ACTIVE_STATUSES = new Set(['PENDING', 'CONFIRMED', 'RESCHEDULED', 'IN_PROGRESS']);

/**
 * The diary.
 *
 * Every row is (week relative to this Monday, weekday, local start minute).
 * Per staff member no two entries share a day, which is what keeps the
 * buffered windows disjoint and the exclusion constraint satisfied; the same
 * holds for the rooms and the recovery rig.
 */
const APPOINTMENT_PLAN = [
  // ---- the past 60 days ---------------------------------------------------
  {
    ref: 'P1',
    week: -8,
    day: MON,
    minute: 600,
    service: 'DEEP',
    staff: 'RAHUL',
    customer: 'NEHA',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    answers: { goal: 'Lower back tension from desk work', firstVisit: true },
  },
  {
    ref: 'P2',
    week: -8,
    day: WED,
    minute: 660,
    service: 'FACIAL',
    staff: 'ANANYA',
    customer: 'FATIMA',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P3',
    week: -8,
    day: FRI,
    minute: 600,
    service: 'SWEDISH',
    staff: 'RAHUL',
    customer: 'ARJUN',
    status: 'COMPLETED',
    source: 'STAFF',
    location: 'INDIRANAGAR',
    link: null,
    bookedBy: 'RAHUL',
    internalNotes: 'Walk-in; booked at the desk.',
  },
  {
    ref: 'P4',
    week: -7,
    day: TUE,
    minute: 630,
    service: 'PHYSIO',
    staff: 'VIKRAM',
    customer: 'DANIEL',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P5',
    week: -7,
    day: THU,
    minute: 960,
    service: 'SWEDISH',
    staff: 'ANANYA',
    customer: 'NEHA',
    status: 'CANCELLED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    cancelledDaysBefore: 3,
    cancelledBy: 'CUSTOMER',
    cancellationReason: 'Travelling for work that week.',
  },
  {
    ref: 'P6',
    week: -7,
    day: SAT,
    minute: 540,
    service: 'YOGA',
    staff: 'VIKRAM',
    customer: 'NEHA',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'KORAMANGALA',
    link: 'YOGA',
    title: 'Hatha Yoga — Morning Flow',
    guests: ['ARJUN', 'FATIMA'],
    answers: { experience: 'Beginner' },
  },
  {
    ref: 'P7',
    week: -6,
    day: TUE,
    minute: 900,
    service: 'DEEP',
    staff: 'ANANYA',
    customer: 'ARJUN',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P8',
    week: -6,
    day: THU,
    minute: 660,
    service: 'CONSULT',
    staff: 'RAHUL',
    customer: 'FATIMA',
    status: 'COMPLETED',
    source: 'OWNER',
    location: 'INDIRANAGAR',
    link: null,
    bookedBy: 'OWNER',
  },
  {
    ref: 'P9',
    week: -5,
    day: WED,
    minute: 600,
    service: 'FACIAL',
    staff: 'ANANYA',
    customer: 'DANIEL',
    status: 'NO_SHOW',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P10',
    week: -5,
    day: FRI,
    minute: 780,
    service: 'SWEDISH',
    staff: 'RAHUL',
    customer: 'NEHA',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P11',
    week: -4,
    day: TUE,
    minute: 600,
    service: 'PHYSIO',
    staff: 'VIKRAM',
    customer: 'ARJUN',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'P12',
    week: -4,
    day: SAT,
    minute: 540,
    service: 'YOGA',
    staff: 'VIKRAM',
    customer: 'FATIMA',
    status: 'COMPLETED',
    source: 'PUBLIC',
    location: 'KORAMANGALA',
    link: 'YOGA',
    title: 'Hatha Yoga — Morning Flow',
    guests: ['DANIEL', 'NEHA', 'ARJUN'],
    guestOverrides: { ARJUN: 'NO_SHOW' },
    answers: { experience: 'Intermediate' },
  },
  {
    ref: 'P13',
    week: -3,
    day: MON,
    minute: 660,
    service: 'DEEP',
    staff: 'RAHUL',
    customer: 'DANIEL',
    status: 'COMPLETED',
    source: 'STAFF',
    location: 'INDIRANAGAR',
    link: null,
    bookedBy: 'RAHUL',
    // Moved an hour later by the front desk before it was delivered.
    rescheduledFromMinute: 600,
    rescheduleActor: 'STAFF',
    rescheduleActorUser: 'RAHUL',
    rescheduleReason: 'Therapist ran late after a double-length session.',
  },
  {
    ref: 'P14',
    week: -2,
    day: WED,
    minute: 960,
    service: 'SWEDISH',
    staff: 'ANANYA',
    customer: 'ARJUN',
    status: 'CANCELLED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    cancelledHoursBefore: 2,
    cancelledBy: 'CUSTOMER',
    lateCancellation: true,
    cancellationReason: 'Cancelled inside the 12 hour window.',
  },
  {
    ref: 'P15',
    week: -1,
    day: THU,
    minute: 660,
    service: 'DEEP',
    staff: 'RAHUL',
    customer: 'NEHA',
    status: 'NO_SHOW',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    internalNotes: 'Second no-show this quarter — flag at next booking.',
  },

  // ---- the next 30 days ---------------------------------------------------
  {
    ref: 'F1',
    week: 1,
    day: MON,
    minute: 600,
    service: 'DEEP',
    staff: 'RAHUL',
    customer: 'ARJUN',
    status: 'CONFIRMED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    answers: { goal: 'Shoulder mobility', firstVisit: false },
    customerNotes: 'Please focus on the right shoulder.',
  },
  {
    ref: 'F2',
    week: 1,
    day: WED,
    minute: 660,
    service: 'FACIAL',
    staff: 'ANANYA',
    customer: 'NEHA',
    status: 'RESCHEDULED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    rescheduledFromDay: TUE,
    rescheduleActor: 'CUSTOMER',
    rescheduleReason: 'Customer moved it a day later.',
  },
  {
    ref: 'F3',
    week: 1,
    day: FRI,
    minute: 1020,
    service: 'SWEDISH',
    staff: 'RAHUL',
    customer: 'FATIMA',
    status: 'CONFIRMED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'F4',
    week: 1,
    day: SAT,
    minute: 540,
    service: 'YOGA',
    staff: 'VIKRAM',
    customer: 'DANIEL',
    status: 'CONFIRMED',
    source: 'PUBLIC',
    location: 'KORAMANGALA',
    link: 'YOGA',
    title: 'Hatha Yoga — Morning Flow',
    guests: ['NEHA', 'ARJUN', 'FATIMA'],
    answers: { experience: 'Beginner' },
  },
  {
    ref: 'F5',
    week: 2,
    day: TUE,
    minute: 630,
    service: 'PHYSIO',
    staff: 'VIKRAM',
    customer: 'NEHA',
    status: 'CONFIRMED',
    source: 'STAFF',
    location: 'INDIRANAGAR',
    link: null,
    bookedBy: 'VIKRAM',
  },
  {
    ref: 'F6',
    week: 2,
    day: THU,
    minute: 900,
    service: 'CONSULT',
    staff: 'RAHUL',
    customer: 'DANIEL',
    status: 'PENDING',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'F7',
    week: 2,
    day: FRI,
    minute: 660,
    service: 'DEEP',
    staff: 'ANANYA',
    customer: 'FATIMA',
    status: 'CONFIRMED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'F8',
    week: 3,
    day: TUE,
    minute: 600,
    service: 'SWEDISH',
    staff: 'ANANYA',
    customer: 'ARJUN',
    status: 'CONFIRMED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
  {
    ref: 'F9',
    week: 3,
    day: WED,
    minute: 1020,
    service: 'FACIAL',
    staff: 'ANANYA',
    customer: 'DANIEL',
    status: 'CANCELLED',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
    cancelledDaysBefore: 4,
    cancelledBy: 'STAFF',
    cancelledByUser: 'OWNER',
    cancellationReason: 'Studio closed that afternoon for the annual deep clean.',
  },
  {
    ref: 'F10',
    week: 4,
    day: TUE,
    minute: 660,
    service: 'CONSULT',
    staff: 'VIKRAM',
    customer: 'NEHA',
    status: 'PENDING',
    source: 'PUBLIC',
    location: 'INDIRANAGAR',
    link: 'CATALOG',
  },
];

// ---------------------------------------------------------------------------
// Derived appointment graph
// ---------------------------------------------------------------------------

/**
 * Expands APPOINTMENT_PLAN into the rows of every table that hangs off an
 * appointment. Doing it in one pass is what keeps participant counts, customer
 * counters, status history and reservations agreeing with each other.
 */
function buildAppointmentGraph(timeline) {
  const appointments = [];
  const staffReservations = [];
  const participants = [];
  const resourceReservations = [];
  const statusHistory = [];
  const rescheduleHistory = [];
  const byRef = new Map();

  APPOINTMENT_PLAN.forEach((plan, planIndex) => {
    const index = planIndex + 1;
    const service = SERVICES[plan.service];
    const staff = STAFF[plan.staff];
    const customer = CUSTOMERS[plan.customer];

    const preBuffer = service.preBuffer ?? DEFAULT_PRE_BUFFER;
    const postBuffer = service.postBuffer ?? DEFAULT_POST_BUFFER;

    const startsAt = timeline.at(plan.week, plan.day, plan.minute);
    const endsAt = minutesAfter(startsAt, service.duration);
    const bufferStartAt = minutesAfter(startsAt, -preBuffer);
    const bufferEndAt = minutesAfter(endsAt, postBuffer);

    const isActive = ACTIVE_STATUSES.has(plan.status);
    const appointmentId = id('70000000', index);
    // Shaped like publicId('apt') in src/utils/ids.ts: the prefix plus 26
    // characters of the Crockford alphabet, which the public API's regex
    // accepts. Opaque is not required of a demo row, uniqueness is.
    const appointmentPublicId = `apt_DEM0${String(index).padStart(22, '0')}`;
    const bookedBy = plan.bookedBy ? PEOPLE[plan.bookedBy] : null;

    // Booked a week out where that is still in the past, otherwise two days
    // ago: a demo row must never claim to have been created in the future.
    const createdAt = new Date(
      Math.min(daysBefore(startsAt, 6).getTime(), daysBefore(timeline.now, 2).getTime()),
    );

    let cancelledAt = null;
    if (plan.status === 'CANCELLED') {
      cancelledAt = alreadyHappened(
        plan.cancelledHoursBefore !== undefined
          ? minutesAfter(startsAt, -plan.cancelledHoursBefore * 60)
          : daysBefore(startsAt, plan.cancelledDaysBefore ?? 2),
        timeline.now,
      );
    }
    const wasRescheduled =
      plan.rescheduledFromMinute !== undefined || plan.rescheduledFromDay !== undefined;
    const rescheduledAt = wasRescheduled
      ? alreadyHappened(daysBefore(startsAt, 3), timeline.now)
      : null;
    const noShowAt =
      plan.status === 'NO_SHOW' ? minutesAfter(startsAt, NO_SHOW_GRACE_MINUTES) : null;
    const confirmedAt = plan.status === 'PENDING' ? null : minutesAfter(createdAt, 1);

    const guests = plan.guests ?? [];
    const participantStatus =
      {
        COMPLETED: 'ATTENDED',
        CANCELLED: 'CANCELLED',
        NO_SHOW: 'NO_SHOW',
      }[plan.status] ?? 'BOOKED';

    const attendees = [
      { customerRef: plan.customer, role: 'ORGANIZER', status: participantStatus },
      ...guests.map((ref) => ({
        customerRef: ref,
        role: 'ATTENDEE',
        status: plan.guestOverrides?.[ref] ?? participantStatus,
      })),
    ];

    appointments.push({
      id: appointmentId,
      public_id: appointmentPublicId,
      business_id: BUSINESS,
      service_id: service.id,
      location_id: LOCATIONS[plan.location],
      staff_profile_id: staff.profileId,
      team_id: service.team,
      customer_id: customer.id,
      booking_link_id: plan.link ? LINKS[plan.link] : null,
      status: plan.status,
      starts_at: startsAt,
      ends_at: endsAt,
      buffer_start_at: bufferStartAt,
      buffer_end_at: bufferEndAt,
      duration_minutes: service.duration,
      pre_buffer_minutes: preBuffer,
      post_buffer_minutes: postBuffer,
      timezone: 'Asia/Kolkata',
      capacity: service.capacity,
      booked_count: attendees.filter((attendee) => attendee.status !== 'CANCELLED').length,
      price_amount: service.price,
      currency: 'INR',
      source: plan.source,
      title: plan.title ?? null,
      customer_notes: plan.customerNotes ?? null,
      internal_notes: plan.internalNotes ?? null,
      answers: plan.answers ?? {},
      requires_approval: service.requiresApproval,
      confirmed_at: confirmedAt,
      checked_in_at: plan.status === 'COMPLETED' ? minutesAfter(startsAt, -5) : null,
      started_at: plan.status === 'COMPLETED' ? startsAt : null,
      completed_at: plan.status === 'COMPLETED' ? endsAt : null,
      cancelled_at: cancelledAt,
      no_show_at: noShowAt,
      cancellation_reason: plan.cancellationReason ?? null,
      cancelled_by_type: plan.status === 'CANCELLED' ? (plan.cancelledBy ?? 'CUSTOMER') : null,
      cancelled_by_user_id: plan.cancelledByUser ? PEOPLE[plan.cancelledByUser].userId : null,
      late_cancellation: plan.lateCancellation === true,
      // The row keeps its identity across a move so the customer's manage link
      // never breaks; reschedule_history is where the moves are recorded.
      rescheduled_from_id: null,
      reschedule_count: wasRescheduled ? 1 : 0,
      // Public bookings arrive through the idempotent endpoint and keep the key.
      idempotency_key: plan.source === 'PUBLIC' ? `pub_demo_${plan.ref.toLowerCase()}` : null,
      created_by_user_id: bookedBy ? bookedBy.userId : null,
      created_at: createdAt,
      updated_at: cancelledAt ?? noShowAt ?? (plan.status === 'COMPLETED' ? endsAt : createdAt),
    });

    staffReservations.push({
      id: id('71000000', index),
      appointment_id: appointmentId,
      staff_profile_id: staff.profileId,
      role: 'PRIMARY',
      starts_at: bufferStartAt,
      ends_at: bufferEndAt,
      // Cleared rather than deleted once an appointment leaves the active set:
      // the assignment stays auditable while the calendar frees up.
      is_blocking: isActive,
      created_at: createdAt,
      updated_at: createdAt,
    });

    attendees.forEach((attendee, attendeeIndex) => {
      const ordinal = index * 10 + attendeeIndex;
      participants.push({
        id: id('72000000', ordinal),
        appointment_id: appointmentId,
        customer_id: CUSTOMERS[attendee.customerRef].id,
        public_id: `atn_DEM0${String(ordinal).padStart(22, '0')}`,
        role: attendee.role,
        status: attendee.status,
        answers: attendeeIndex === 0 ? (plan.answers ?? {}) : {},
        joined_at: createdAt,
        cancelled_at: attendee.status === 'CANCELLED' ? cancelledAt : null,
        created_at: createdAt,
        updated_at: createdAt,
      });
    });

    service.resources.forEach((requirement, resourceIndex) => {
      resourceReservations.push({
        id: id('73000000', index * 10 + resourceIndex),
        appointment_id: appointmentId,
        resource_id: requirement.resourceId,
        quantity: 1,
        starts_at: bufferStartAt,
        ends_at: bufferEndAt,
        is_exclusive: requirement.exclusive,
        is_active: isActive,
        created_at: createdAt,
        updated_at: createdAt,
      });
    });

    // --- lifecycle -------------------------------------------------------
    const bookingActor =
      { PUBLIC: 'CUSTOMER', STAFF: 'STAFF', OWNER: 'OWNER' }[plan.source] ?? 'SYSTEM';
    const events = [
      {
        from: null,
        to: 'PENDING',
        actorType: bookingActor,
        actorUserId: bookedBy ? bookedBy.userId : null,
        actorLabel: bookedBy
          ? `${bookedBy.name} <${bookedBy.email}>`
          : `${customer.firstName} ${customer.lastName} <${customer.email}>`,
        reason: null,
        at: createdAt,
        metadata: { source: plan.source },
      },
    ];

    if (plan.status !== 'PENDING') {
      events.push({
        from: 'PENDING',
        to: 'CONFIRMED',
        actorType: 'SYSTEM',
        actorUserId: null,
        actorLabel: 'MeetFlow booking engine',
        reason: null,
        at: confirmedAt,
        metadata: { autoConfirmed: true },
      });
    }

    if (plan.status === 'RESCHEDULED') {
      events.push({
        from: 'CONFIRMED',
        to: 'RESCHEDULED',
        actorType: plan.rescheduleActor,
        actorUserId: plan.rescheduleActorUser ? PEOPLE[plan.rescheduleActorUser].userId : null,
        actorLabel: `${customer.firstName} ${customer.lastName}`,
        reason: plan.rescheduleReason ?? null,
        at: rescheduledAt,
        metadata: {},
      });
    }

    const terminal = {
      COMPLETED: { to: 'COMPLETED', actorType: 'STAFF', at: endsAt },
      CANCELLED: { to: 'CANCELLED', actorType: plan.cancelledBy ?? 'CUSTOMER', at: cancelledAt },
      NO_SHOW: { to: 'NO_SHOW', actorType: 'STAFF', at: noShowAt },
    }[plan.status];

    if (terminal) {
      events.push({
        from: 'CONFIRMED',
        to: terminal.to,
        actorType: terminal.actorType,
        actorUserId: terminal.actorType === 'STAFF' ? staff.userId : null,
        actorLabel:
          terminal.actorType === 'STAFF'
            ? `${staff.name} <${staff.email}>`
            : `${customer.firstName} ${customer.lastName}`,
        reason: plan.cancellationReason ?? null,
        at: terminal.at,
        metadata: plan.lateCancellation === true ? { lateCancellation: true } : {},
      });
    }

    events.forEach((event, eventIndex) => {
      statusHistory.push({
        id: id('74000000', index * 10 + eventIndex),
        appointment_id: appointmentId,
        business_id: BUSINESS,
        from_status: event.from,
        to_status: event.to,
        actor_type: event.actorType,
        actor_user_id: event.actorUserId,
        actor_label: event.actorLabel,
        reason: event.reason,
        metadata: event.metadata,
        created_at: event.at,
      });
    });

    if (wasRescheduled) {
      const previousStartsAt = timeline.at(
        plan.week,
        plan.rescheduledFromDay ?? plan.day,
        plan.rescheduledFromMinute ?? plan.minute,
      );
      rescheduleHistory.push({
        id: id('75000000', index),
        appointment_id: appointmentId,
        business_id: BUSINESS,
        previous_starts_at: previousStartsAt,
        previous_ends_at: minutesAfter(previousStartsAt, service.duration),
        new_starts_at: startsAt,
        new_ends_at: endsAt,
        previous_staff_profile_id: staff.profileId,
        new_staff_profile_id: staff.profileId,
        previous_location_id: LOCATIONS[plan.location],
        new_location_id: LOCATIONS[plan.location],
        reason: plan.rescheduleReason ?? null,
        actor_type: plan.rescheduleActor,
        actor_user_id: plan.rescheduleActorUser ? PEOPLE[plan.rescheduleActorUser].userId : null,
        late_reschedule: false,
        created_at: rescheduledAt,
      });
    }

    // Notifications and audit entries refer to appointments by plan reference,
    // and must reuse these instants rather than recompute them.
    byRef.set(plan.ref, {
      appointmentId,
      publicId: appointmentPublicId,
      startsAt,
      endsAt,
      createdAt,
      cancelledAt,
      rescheduledAt,
    });
  });

  return {
    appointments,
    staffReservations,
    participants,
    resourceReservations,
    statusHistory,
    rescheduleHistory,
    byRef,
  };
}

/**
 * The two GiST exclusion constraints in 20250101000600-create-booking.cjs are
 * the last word on double booking. Checking the same rule here means a mistake
 * in the plan above is reported as a readable seed error instead of a raw
 * 23P01 exclusion_violation halfway through the insert.
 */
function assertNoOverlaps(rows, keyColumn, activeColumn, label) {
  const groups = new Map();
  for (const row of rows) {
    if (!row[activeColumn]) continue;
    const key = row[keyColumn];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const [key, reservations] of groups) {
    reservations.sort((a, b) => a.starts_at - b.starts_at);
    for (let index = 1; index < reservations.length; index += 1) {
      const previous = reservations[index - 1];
      const current = reservations[index];
      if (current.starts_at < previous.ends_at) {
        throw new Error(
          `Demo seed would violate ${label} for ${key}: ` +
            `${previous.starts_at.toISOString()}–${previous.ends_at.toISOString()} overlaps ` +
            `${current.starts_at.toISOString()}–${current.ends_at.toISOString()}.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/**
 * Builds every table's rows in dependency order. `down()` walks the same list
 * backwards and deletes by the same keys, which is why insertion and deletion
 * can never drift apart.
 *
 * `passwordHash` is only needed by `up()`; `down()` passes null because it
 * reads nothing but identifiers.
 */
function buildDataset(passwordHash, now) {
  const timeline = buildTimeline(now);
  const graph = buildAppointmentGraph(timeline);

  assertNoOverlaps(
    graph.staffReservations,
    'staff_profile_id',
    'is_blocking',
    'appointment_staff_no_overlap',
  );
  assertNoOverlaps(
    graph.resourceReservations.filter((row) => row.is_exclusive),
    'resource_id',
    'is_active',
    'appointment_resources_no_overlap',
  );

  const seededAt = daysBefore(now, 120);
  const scheduleFrom = timeline.date(-9, MON);

  // --- counters derived from the diary, never hand-typed --------------------
  const appointmentById = new Map(graph.appointments.map((row) => [row.id, row]));
  const customerStats = new Map(
    Object.values(CUSTOMERS).map((customer) => [
      customer.id,
      { total: 0, completed: 0, cancelled: 0, noShow: 0, first: null, last: null },
    ]),
  );
  for (const participant of graph.participants) {
    const stats = customerStats.get(participant.customer_id);
    const appointment = appointmentById.get(participant.appointment_id);
    stats.total += 1;
    if (participant.status === 'ATTENDED') stats.completed += 1;
    if (participant.status === 'CANCELLED') stats.cancelled += 1;
    if (participant.status === 'NO_SHOW') stats.noShow += 1;
    if (!stats.first || appointment.starts_at < stats.first) stats.first = appointment.starts_at;
    if (!stats.last || appointment.starts_at > stats.last) stats.last = appointment.starts_at;
  }

  const linkCounts = new Map([
    [BL_YOGA, 0],
    [BL_CATALOG, 0],
  ]);
  for (const appointment of graph.appointments) {
    if (appointment.booking_link_id) {
      linkCounts.set(appointment.booking_link_id, linkCounts.get(appointment.booking_link_id) + 1);
    }
  }

  const appointmentOf = (ref) => graph.byRef.get(ref);

  // --- rows ----------------------------------------------------------------
  const user = (userId, person, extra) => ({
    id: userId,
    email: person.email,
    password_hash: passwordHash,
    first_name: person.first,
    last_name: person.last,
    phone: person.phone ?? null,
    avatar_url: null,
    platform_role: extra.platformRole ?? 'USER',
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    email_verified_at: seededAt,
    last_login_at: daysBefore(now, extra.lastLoginDaysAgo),
    created_at: seededAt,
    updated_at: seededAt,
  });

  const users = [
    user(
      U_ADMIN,
      { email: PEOPLE.ADMIN.email, first: 'Aarav', last: 'Krishnan', phone: '+919845000001' },
      { platformRole: 'ADMIN', lastLoginDaysAgo: 1 },
    ),
    user(
      U_OWNER,
      { email: PEOPLE.OWNER.email, first: 'Priya', last: 'Shah', phone: '+919845000002' },
      { lastLoginDaysAgo: 0 },
    ),
    user(
      U_RAHUL,
      { email: PEOPLE.RAHUL.email, first: 'Rahul', last: 'Menon', phone: '+919845000003' },
      { lastLoginDaysAgo: 1 },
    ),
    user(
      U_ANANYA,
      { email: PEOPLE.ANANYA.email, first: 'Ananya', last: 'Iyer', phone: '+919845000004' },
      { lastLoginDaysAgo: 2 },
    ),
    user(
      U_VIKRAM,
      { email: PEOPLE.VIKRAM.email, first: 'Vikram', last: 'Desai', phone: '+919845000005' },
      { lastLoginDaysAgo: 3 },
    ),
    ...Object.values(CUSTOMERS).map((customer, index) =>
      user(
        customer.userId,
        {
          email: customer.email,
          first: customer.firstName,
          last: customer.lastName,
          phone: customer.phone,
        },
        { lastLoginDaysAgo: 4 + index },
      ),
    ),
  ];

  const businesses = [
    {
      id: BUSINESS,
      slug: 'aurora-wellness-studio',
      name: 'Aurora Wellness Studio',
      legal_name: 'Aurora Wellness Studio Private Limited',
      description: 'Massage therapy, skin care and movement classes across two Bengaluru studios.',
      industry: 'Health & Wellness',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      locale: 'en-IN',
      logo_url: null,
      website_url: 'https://aurorawellness.test',
      support_email: 'hello@aurorawellness.test',
      support_phone: '+918041000100',
      status: 'ACTIVE',
      owner_user_id: U_OWNER,
      created_at: seededAt,
      updated_at: seededAt,
    },
  ];

  const businessSettings = [
    {
      business_id: BUSINESS,
      slot_interval_minutes: 15,
      default_pre_buffer_minutes: DEFAULT_PRE_BUFFER,
      default_post_buffer_minutes: DEFAULT_POST_BUFFER,
      min_notice_minutes: 120,
      max_horizon_days: 45,
      cancellation_deadline_minutes: 720,
      reschedule_deadline_minutes: 720,
      allow_customer_cancel: true,
      allow_customer_reschedule: true,
      max_reschedules_per_appointment: 2,
      require_approval: false,
      max_bookings_per_customer_per_day: 2,
      max_bookings_per_staff_per_day: 8,
      no_show_grace_minutes: NO_SHOW_GRACE_MINUTES,
      waitlist_enabled: true,
      waitlist_hold_minutes: 45,
      waitlist_auto_book: false,
      reminder_offsets_minutes: [1440, 120],
      branding: { primaryColor: '#0F766E', accentColor: '#F59E0B', showStaffPhotos: true },
      created_at: seededAt,
      updated_at: seededAt,
    },
  ];

  const roles = [
    {
      id: R_OWNER,
      key: 'BUSINESS_OWNER',
      name: 'Business Owner',
      description: 'Full control of the workspace, its people and its configuration.',
    },
    {
      id: R_MANAGER,
      key: 'MANAGER',
      name: 'Manager',
      description: 'Runs day-to-day operations. Cannot change roles or delete the workspace.',
    },
    {
      id: R_RECEPTIONIST,
      key: 'RECEPTIONIST',
      name: 'Receptionist',
      description: 'Manages the diary and customers without changing configuration.',
    },
    {
      id: R_STAFF,
      key: 'STAFF',
      name: 'Staff',
      description: 'Sees and manages their own schedule and assigned appointments only.',
    },
  ].map((role) => ({
    ...role,
    business_id: BUSINESS,
    is_system: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const membership = (membershipId, userId, roleId, invitedDaysAgo) => ({
    id: membershipId,
    user_id: userId,
    business_id: BUSINESS,
    role_id: roleId,
    status: 'ACTIVE',
    invited_by_user_id: userId === U_OWNER ? null : U_OWNER,
    invited_at: daysBefore(now, invitedDaysAgo),
    joined_at: daysBefore(now, invitedDaysAgo - 1),
    created_at: daysBefore(now, invitedDaysAgo),
    updated_at: daysBefore(now, invitedDaysAgo - 1),
  });

  const memberships = [
    membership(M_OWNER, U_OWNER, R_OWNER, 120),
    membership(M_RAHUL, U_RAHUL, R_MANAGER, 110),
    membership(M_ANANYA, U_ANANYA, R_STAFF, 100),
    membership(M_VIKRAM, U_VIKRAM, R_STAFF, 90),
    // The platform operator holds the narrowest role that still lets support
    // reproduce a front-desk session. platform_role ADMIN grants nothing
    // inside a tenant — only this membership does.
    membership(M_ADMIN, U_ADMIN, R_RECEPTIONIST, 80),
  ];

  const locations = [
    {
      id: L_INDIRANAGAR,
      business_id: BUSINESS,
      name: 'Aurora Indiranagar',
      slug: 'indiranagar',
      type: 'PHYSICAL',
      description: 'Flagship studio with two treatment rooms and a recovery bay.',
      address_line1: '12, 100 Feet Road',
      address_line2: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560038',
      country_code: 'IN',
      timezone: 'Asia/Kolkata',
      phone: '+918041000101',
      email: 'indiranagar@aurorawellness.test',
      virtual_meeting_url: null,
      capacity: 12,
      sort_order: 1,
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
    {
      id: L_KORAMANGALA,
      business_id: BUSINESS,
      name: 'Aurora Koramangala',
      slug: 'koramangala',
      type: 'PHYSICAL',
      description: 'Studio space used for group classes and one treatment room.',
      address_line1: '5th Block, 80 Feet Road',
      address_line2: null,
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560095',
      country_code: 'IN',
      timezone: 'Asia/Kolkata',
      phone: '+918041000102',
      email: 'koramangala@aurorawellness.test',
      virtual_meeting_url: null,
      capacity: 20,
      sort_order: 2,
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
  ];

  const teams = [
    {
      id: T_THERAPY,
      business_id: BUSINESS,
      name: 'Therapy Team',
      slug: 'therapy-team',
      description: 'Massage and bodywork therapists.',
      assignment_strategy: 'ROUND_ROBIN',
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
    {
      id: T_MOVEMENT,
      business_id: BUSINESS,
      name: 'Movement & Recovery',
      slug: 'movement-recovery',
      description: 'Physiotherapy and group movement classes.',
      assignment_strategy: 'POOLED',
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
  ];

  const staffProfiles = [
    {
      id: SP_RAHUL,
      business_id: BUSINESS,
      user_id: U_RAHUL,
      membership_id: M_RAHUL,
      display_name: 'Rahul Menon',
      title: 'Lead Massage Therapist',
      bio: 'Fifteen years of deep tissue and sports massage practice.',
      avatar_url: null,
      timezone: 'Asia/Kolkata',
      color: '#0F766E',
      default_location_id: L_INDIRANAGAR,
      is_bookable: true,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      min_notice_minutes: null,
      max_daily_appointments: 6,
      max_weekly_appointments: 26,
      last_assigned_at: null,
      assignment_weight: 2,
      sort_order: 1,
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
    {
      id: SP_ANANYA,
      business_id: BUSINESS,
      user_id: U_ANANYA,
      membership_id: M_ANANYA,
      display_name: 'Ananya Iyer',
      title: 'Senior Esthetician & Therapist',
      bio: 'Facials, aromatherapy and relaxation massage.',
      avatar_url: null,
      timezone: 'Asia/Kolkata',
      color: '#B45309',
      default_location_id: L_INDIRANAGAR,
      is_bookable: true,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      min_notice_minutes: 180,
      max_daily_appointments: 7,
      max_weekly_appointments: 30,
      last_assigned_at: null,
      assignment_weight: 1,
      sort_order: 2,
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
    {
      id: SP_VIKRAM,
      business_id: BUSINESS,
      user_id: U_VIKRAM,
      membership_id: M_VIKRAM,
      display_name: 'Vikram Desai',
      title: 'Physiotherapist & Yoga Instructor',
      bio: 'Rehabilitation programmes and morning Hatha classes.',
      avatar_url: null,
      timezone: 'Asia/Kolkata',
      color: '#4F46E5',
      default_location_id: L_KORAMANGALA,
      is_bookable: true,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      min_notice_minutes: null,
      max_daily_appointments: 8,
      max_weekly_appointments: 32,
      last_assigned_at: null,
      assignment_weight: 1,
      sort_order: 3,
      is_active: true,
      created_at: seededAt,
      updated_at: seededAt,
    },
  ];

  const teamMembers = [
    { team: T_THERAPY, staff: SP_RAHUL, weight: 2, priority: 0 },
    { team: T_THERAPY, staff: SP_ANANYA, weight: 1, priority: 1 },
    { team: T_MOVEMENT, staff: SP_VIKRAM, weight: 2, priority: 0 },
    { team: T_MOVEMENT, staff: SP_RAHUL, weight: 1, priority: 1 },
  ].map((row, index) => ({
    id: id('33000000', index + 1),
    team_id: row.team,
    staff_profile_id: row.staff,
    weight: row.weight,
    priority: row.priority,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const serviceCategories = [
    {
      id: CAT_MASSAGE,
      name: 'Massage & Bodywork',
      slug: 'massage-bodywork',
      description: 'Hands-on therapy for recovery and relaxation.',
      color: '#0F766E',
      sort_order: 1,
    },
    {
      id: CAT_SKIN,
      name: 'Skin & Beauty',
      slug: 'skin-beauty',
      description: 'Facials and skin treatments.',
      color: '#B45309',
      sort_order: 2,
    },
    {
      id: CAT_MOVEMENT,
      name: 'Movement & Recovery',
      slug: 'movement-recovery',
      description: 'Physiotherapy, classes and consultations.',
      color: '#4F46E5',
      sort_order: 3,
    },
  ].map((category) => ({
    ...category,
    business_id: BUSINESS,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const services = [
    {
      id: SVC_DEEP,
      category_id: CAT_MASSAGE,
      name: 'Deep Tissue Massage',
      slug: 'deep-tissue-massage',
      description: 'Firm-pressure work on chronic tension, with room preparation either side.',
      duration_minutes: 90,
      pre_buffer_minutes: 15,
      post_buffer_minutes: 15,
      price_amount: 350000,
      capacity: 1,
      min_notice_minutes: 240,
      max_horizon_days: null,
      slot_interval_minutes: 30,
      max_per_customer_per_day: 1,
      requires_approval: false,
      assignment_strategy: 'SMART_MATCH',
      color: '#0F766E',
      is_public: true,
      sort_order: 1,
    },
    {
      id: SVC_SWEDISH,
      category_id: CAT_MASSAGE,
      name: 'Swedish Relaxation Massage',
      slug: 'swedish-relaxation-massage',
      description: 'Full-body relaxation massage.',
      duration_minutes: 60,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      price_amount: 250000,
      capacity: 1,
      min_notice_minutes: null,
      max_horizon_days: null,
      slot_interval_minutes: null,
      max_per_customer_per_day: null,
      requires_approval: false,
      assignment_strategy: 'ROUND_ROBIN',
      color: '#14B8A6',
      is_public: true,
      sort_order: 2,
    },
    {
      id: SVC_FACIAL,
      category_id: CAT_SKIN,
      name: 'Aromatherapy Facial',
      slug: 'aromatherapy-facial',
      description: 'Cleanse, exfoliation and massage with essential oils.',
      duration_minutes: 45,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      price_amount: 180000,
      capacity: 1,
      min_notice_minutes: null,
      max_horizon_days: null,
      slot_interval_minutes: null,
      max_per_customer_per_day: null,
      requires_approval: false,
      assignment_strategy: 'SMART_MATCH',
      color: '#B45309',
      is_public: true,
      sort_order: 1,
    },
    {
      id: SVC_PHYSIO,
      category_id: CAT_MOVEMENT,
      name: 'Physiotherapy Assessment',
      slug: 'physiotherapy-assessment',
      description: 'Movement screen and treatment plan.',
      duration_minutes: 30,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      price_amount: 150000,
      capacity: 1,
      min_notice_minutes: null,
      max_horizon_days: null,
      slot_interval_minutes: null,
      max_per_customer_per_day: 1,
      requires_approval: false,
      assignment_strategy: 'POOLED',
      color: '#6366F1',
      is_public: true,
      sort_order: 1,
    },
    {
      id: SVC_YOGA,
      category_id: CAT_MOVEMENT,
      name: 'Hatha Yoga Group Class',
      slug: 'hatha-yoga-group-class',
      description: 'Morning Hatha class for up to twelve people, one mat each.',
      duration_minutes: 60,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      price_amount: 60000,
      capacity: 12,
      min_notice_minutes: 60,
      max_horizon_days: 60,
      slot_interval_minutes: 60,
      max_per_customer_per_day: 1,
      requires_approval: false,
      assignment_strategy: 'POOLED',
      color: '#4F46E5',
      is_public: true,
      sort_order: 2,
    },
    {
      id: SVC_CONSULT,
      category_id: CAT_MOVEMENT,
      name: 'Wellness Consultation',
      slug: 'wellness-consultation',
      description:
        'Free thirty-minute consultation. Reviewed by the studio before it is confirmed.',
      duration_minutes: 30,
      pre_buffer_minutes: null,
      post_buffer_minutes: null,
      price_amount: 0,
      capacity: 1,
      min_notice_minutes: 1440,
      max_horizon_days: 30,
      slot_interval_minutes: null,
      max_per_customer_per_day: 1,
      requires_approval: true,
      assignment_strategy: 'SMART_MATCH',
      color: '#0EA5E9',
      is_public: true,
      sort_order: 3,
    },
  ].map((service) => ({
    ...service,
    business_id: BUSINESS,
    currency: 'INR',
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const serviceStaff = [
    { service: SVC_DEEP, staff: SP_RAHUL, priority: 0, weight: 2, duration: null, price: null },
    { service: SVC_DEEP, staff: SP_ANANYA, priority: 1, weight: 1, duration: null, price: null },
    { service: SVC_SWEDISH, staff: SP_RAHUL, priority: 0, weight: 1, duration: null, price: null },
    { service: SVC_SWEDISH, staff: SP_ANANYA, priority: 0, weight: 1, duration: null, price: null },
    { service: SVC_FACIAL, staff: SP_ANANYA, priority: 0, weight: 1, duration: null, price: null },
    { service: SVC_PHYSIO, staff: SP_VIKRAM, priority: 0, weight: 1, duration: null, price: null },
    { service: SVC_YOGA, staff: SP_VIKRAM, priority: 0, weight: 1, duration: null, price: null },
    { service: SVC_CONSULT, staff: SP_RAHUL, priority: 0, weight: 1, duration: null, price: null },
    // The senior therapist charges more for the same consultation slot.
    { service: SVC_CONSULT, staff: SP_VIKRAM, priority: 1, weight: 1, duration: 45, price: 50000 },
  ].map((row, index) => ({
    id: id('42000000', index + 1),
    service_id: row.service,
    staff_profile_id: row.staff,
    duration_minutes_override: row.duration,
    price_amount_override: row.price,
    priority: row.priority,
    weight: row.weight,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const serviceLocations = [
    { service: SVC_DEEP, location: L_INDIRANAGAR },
    { service: SVC_SWEDISH, location: L_INDIRANAGAR },
    { service: SVC_SWEDISH, location: L_KORAMANGALA },
    { service: SVC_FACIAL, location: L_INDIRANAGAR },
    { service: SVC_PHYSIO, location: L_INDIRANAGAR },
    { service: SVC_YOGA, location: L_KORAMANGALA },
    { service: SVC_CONSULT, location: L_INDIRANAGAR },
    { service: SVC_CONSULT, location: L_KORAMANGALA },
  ].map((row, index) => ({
    id: id('43000000', index + 1),
    service_id: row.service,
    location_id: row.location,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const resources = [
    {
      id: RES_ROOM_A,
      location_id: L_INDIRANAGAR,
      name: 'Treatment Room A',
      slug: 'treatment-room-a',
      type: 'ROOM',
      description: 'Main treatment room with a heated table.',
      capacity: 1,
      color: '#0F766E',
    },
    {
      id: RES_ROOM_B,
      location_id: L_KORAMANGALA,
      name: 'Treatment Room B',
      slug: 'treatment-room-b',
      type: 'ROOM',
      description: 'Second treatment room, Koramangala.',
      capacity: 1,
      color: '#14B8A6',
    },
    {
      id: RES_RIG,
      location_id: L_INDIRANAGAR,
      name: 'Physio Recovery Rig',
      slug: 'physio-recovery-rig',
      type: 'EQUIPMENT',
      description: 'Traction and compression equipment.',
      capacity: 1,
      color: '#6366F1',
    },
    {
      id: RES_DESK,
      location_id: L_INDIRANAGAR,
      name: 'Front Desk Consult Pod',
      slug: 'front-desk-consult-pod',
      type: 'DESK',
      description: 'Two-seat pod used for consultations.',
      capacity: 2,
      color: '#0EA5E9',
    },
  ].map((resource) => ({
    ...resource,
    business_id: BUSINESS,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const serviceResourceRequirements = [
    // A specific room: deep tissue is only set up in Room A.
    { service: SVC_DEEP, resourceId: RES_ROOM_A, resourceType: null, quantity: 1, required: true },
    // A pool: any free room will do.
    { service: SVC_FACIAL, resourceId: null, resourceType: 'ROOM', quantity: 1, required: true },
    {
      service: SVC_PHYSIO,
      resourceId: null,
      resourceType: 'EQUIPMENT',
      quantity: 1,
      required: true,
    },
    // Optional: a consultation still happens if the pod is taken.
    { service: SVC_CONSULT, resourceId: null, resourceType: 'DESK', quantity: 1, required: false },
  ].map((row, index) => ({
    id: id('45000000', index + 1),
    service_id: row.service,
    resource_id: row.resourceId,
    resource_type: row.resourceType,
    quantity: row.quantity,
    is_required: row.required,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  // Mon–Fri 09:00–20:00, Saturday 09:00–18:00, closed Sunday.
  const businessHours = [1, 2, 3, 4, 5, 6].map((dayOfWeek, index) => ({
    id: id('50000000', index + 1),
    business_id: BUSINESS,
    location_id: null,
    day_of_week: dayOfWeek,
    start_minute: 540,
    end_minute: dayOfWeek === 6 ? 1080 : 1200,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const staffAvailability = [
    ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({
      staff: SP_RAHUL,
      location: L_INDIRANAGAR,
      dayOfWeek,
      start: 540,
      end: 1140,
    })),
    ...[2, 3, 4, 5, 6].map((dayOfWeek) => ({
      staff: SP_ANANYA,
      location: L_INDIRANAGAR,
      dayOfWeek,
      start: 540,
      end: 1080,
    })),
    // Location NULL: the instructor teaches at Koramangala and treats at
    // Indiranagar within the same working window.
    ...[2, 3, 5, 6].map((dayOfWeek) => ({
      staff: SP_VIKRAM,
      location: null,
      dayOfWeek,
      start: 540,
      end: 900,
    })),
  ].map((row, index) => ({
    id: id('51000000', index + 1),
    business_id: BUSINESS,
    staff_profile_id: row.staff,
    location_id: row.location,
    day_of_week: row.dayOfWeek,
    start_minute: row.start,
    end_minute: row.end,
    effective_from: scheduleFrom,
    effective_to: null,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const availabilityOverrides = [
    {
      id: id('52000000', 1),
      business_id: BUSINESS,
      scope: 'STAFF',
      staff_profile_id: SP_ANANYA,
      location_id: null,
      resource_id: null,
      date: timeline.date(3, THU),
      is_available: false,
      start_minute: null,
      end_minute: null,
      reason: 'LEAVE',
      note: 'Family wedding — full day off.',
      created_by_user_id: U_OWNER,
      created_at: daysBefore(now, 5),
      updated_at: daysBefore(now, 5),
    },
    {
      id: id('52000000', 2),
      business_id: BUSINESS,
      scope: 'STAFF',
      staff_profile_id: SP_RAHUL,
      location_id: null,
      resource_id: null,
      date: timeline.date(2, SAT),
      is_available: true,
      start_minute: 600,
      end_minute: 900,
      reason: 'EXTRA_HOURS',
      note: 'Covering Saturday morning for the corporate package.',
      created_by_user_id: U_OWNER,
      created_at: daysBefore(now, 4),
      updated_at: daysBefore(now, 4),
    },
  ];

  const holidayYear = now.getUTCFullYear();
  const holidays = [
    { id: id('53000000', 1), name: 'Republic Day', date: `${holidayYear}-01-26` },
    { id: id('53000000', 2), name: 'Independence Day', date: `${holidayYear}-08-15` },
  ].map((holiday) => ({
    ...holiday,
    business_id: BUSINESS,
    location_id: null,
    is_recurring_annually: true,
    closes_business: true,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const blackoutPeriods = [
    {
      id: id('54000000', 1),
      business_id: BUSINESS,
      scope: 'BUSINESS',
      staff_profile_id: null,
      location_id: null,
      resource_id: null,
      starts_at: timeline.at(3, FRI, 0),
      ends_at: timeline.at(3, FRI, 1440),
      reason: 'CLOSURE',
      note: 'Annual deep clean — both studios closed for the day.',
      created_by_user_id: U_OWNER,
      created_at: daysBefore(now, 20),
      updated_at: daysBefore(now, 20),
    },
  ];

  const customers = [
    {
      ref: 'NEHA',
      staff: SP_RAHUL,
      location: L_INDIRANAGAR,
      tags: ['vip', 'member'],
      notes: 'Prefers firm pressure and a quiet room.',
    },
    { ref: 'ARJUN', staff: SP_ANANYA, location: L_INDIRANAGAR, tags: ['member'], notes: null },
    {
      ref: 'FATIMA',
      staff: SP_ANANYA,
      location: L_INDIRANAGAR,
      tags: ['new'],
      notes: 'Sensitive skin — patch test before new products.',
    },
    { ref: 'DANIEL', staff: SP_VIKRAM, location: L_KORAMANGALA, tags: ['corporate'], notes: null },
  ].map((row) => {
    const customer = CUSTOMERS[row.ref];
    const stats = customerStats.get(customer.id);
    return {
      id: customer.id,
      business_id: BUSINESS,
      public_id: customer.publicId,
      user_id: customer.userId,
      first_name: customer.firstName,
      last_name: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      notes: row.notes,
      tags: row.tags,
      preferred_staff_profile_id: row.staff,
      preferred_location_id: row.location,
      communication_preferences: {
        emailEnabled: true,
        smsEnabled: row.tags.includes('vip'),
        marketingOptIn: row.tags.includes('member'),
      },
      status: 'ACTIVE',
      total_bookings: stats.total,
      completed_count: stats.completed,
      cancelled_count: stats.cancelled,
      no_show_count: stats.noShow,
      first_appointment_at: stats.first,
      last_appointment_at: stats.last,
      created_at: seededAt,
      updated_at: seededAt,
    };
  });

  const bookingLinks = [
    {
      id: BL_YOGA,
      slug: 'aurora-yoga-drop-in',
      name: 'Hatha Yoga drop-in',
      description: 'Book a mat in the Saturday morning class.',
      type: 'SINGLE_SERVICE',
      service_id: SVC_YOGA,
      team_id: null,
      staff_profile_id: null,
      location_id: L_KORAMANGALA,
      allow_staff_selection: false,
      requires_approval: false,
      custom_questions: [
        {
          key: 'experience',
          label: 'Yoga experience',
          type: 'SELECT',
          required: true,
          options: ['Beginner', 'Intermediate', 'Advanced'],
        },
      ],
      max_bookings_total: 200,
    },
    {
      id: BL_CATALOG,
      slug: 'aurora-wellness-studio',
      name: 'Aurora Wellness Studio',
      description: 'Browse and book any treatment at either studio.',
      type: 'CATALOG',
      service_id: null,
      team_id: null,
      staff_profile_id: null,
      location_id: null,
      allow_staff_selection: true,
      requires_approval: false,
      custom_questions: [
        {
          key: 'goal',
          label: 'What would you like us to focus on?',
          type: 'TEXT',
          required: false,
        },
        { key: 'firstVisit', label: 'Is this your first visit?', type: 'BOOLEAN', required: true },
      ],
      max_bookings_total: null,
    },
  ].map((link) => ({
    ...link,
    business_id: BUSINESS,
    branding: { primaryColor: '#0F766E' },
    booking_count: linkCounts.get(link.id),
    expires_at: null,
    is_active: true,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const bookingLinkServices = [
    { link: BL_YOGA, service: SVC_YOGA, sort: 0 },
    { link: BL_CATALOG, service: SVC_DEEP, sort: 0 },
    { link: BL_CATALOG, service: SVC_SWEDISH, sort: 1 },
    { link: BL_CATALOG, service: SVC_FACIAL, sort: 2 },
    { link: BL_CATALOG, service: SVC_CONSULT, sort: 3 },
  ].map((row, index) => ({
    id: id('62000000', index + 1),
    booking_link_id: row.link,
    service_id: row.service,
    sort_order: row.sort,
    created_at: seededAt,
    updated_at: seededAt,
  }));

  const yogaSlot = appointmentOf('F4');
  const waitlistEntries = [
    {
      id: W_FATIMA,
      public_id: `wlt_DEM0${String(1).padStart(22, '0')}`,
      business_id: BUSINESS,
      customer_id: C_FATIMA,
      service_id: SVC_DEEP,
      staff_profile_id: SP_RAHUL,
      location_id: L_INDIRANAGAR,
      earliest_date: timeline.date(1, MON),
      latest_date: timeline.date(3, SAT),
      earliest_minute: 600,
      latest_minute: 1140,
      days_of_week: [1, 3, 5],
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
      priority: 50,
      notify_channel: 'EMAIL',
      notified_at: null,
      notification_count: 0,
      hold_expires_at: null,
      held_slot_starts_at: null,
      converted_appointment_id: null,
      expires_at: timeline.at(4, SAT, 1200),
      note: 'Happy with any evening slot with Rahul.',
      created_at: daysBefore(now, 6),
      updated_at: daysBefore(now, 6),
    },
    {
      id: W_DANIEL,
      public_id: `wlt_DEM0${String(2).padStart(22, '0')}`,
      business_id: BUSINESS,
      customer_id: C_DANIEL,
      service_id: SVC_YOGA,
      staff_profile_id: null,
      location_id: L_KORAMANGALA,
      earliest_date: timeline.date(1, SAT),
      latest_date: timeline.date(2, SAT),
      earliest_minute: 480,
      latest_minute: 720,
      days_of_week: [6],
      timezone: 'Asia/Kolkata',
      status: 'NOTIFIED',
      priority: 100,
      notify_channel: 'EMAIL',
      notified_at: minutesAfter(now, -20),
      notification_count: 1,
      // Exclusive claim on the opening they were told about, per waitlist_hold_minutes.
      hold_expires_at: minutesAfter(now, 25),
      held_slot_starts_at: yogaSlot.startsAt,
      converted_appointment_id: null,
      expires_at: timeline.at(2, SAT, 1200),
      note: null,
      created_at: daysBefore(now, 3),
      updated_at: minutesAfter(now, -20),
    },
    {
      id: W_ARJUN,
      public_id: `wlt_DEM0${String(3).padStart(22, '0')}`,
      business_id: BUSINESS,
      customer_id: C_ARJUN,
      service_id: SVC_FACIAL,
      staff_profile_id: SP_ANANYA,
      location_id: L_INDIRANAGAR,
      earliest_date: timeline.date(-3, MON),
      latest_date: timeline.date(-2, SAT),
      earliest_minute: 540,
      latest_minute: 1080,
      days_of_week: [],
      timezone: 'Asia/Kolkata',
      status: 'EXPIRED',
      priority: 100,
      notify_channel: 'EMAIL',
      notified_at: null,
      notification_count: 0,
      hold_expires_at: null,
      held_slot_starts_at: null,
      converted_appointment_id: null,
      expires_at: timeline.at(-2, SAT, 1200),
      note: 'No opening came up in the requested window.',
      created_at: timeline.at(-4, MON, 600),
      updated_at: timeline.at(-2, SAT, 1200),
    },
  ];

  const notification = (index, row) => ({
    id: id('80000000', index),
    business_id: BUSINESS,
    channel: 'EMAIL',
    appointment_id: null,
    waitlist_entry_id: null,
    recipient_customer_id: null,
    recipient_user_id: null,
    body: null,
    payload: {},
    sent_at: null,
    failed_at: null,
    attempt_count: 0,
    max_attempts: 5,
    last_error: null,
    provider_message_id: null,
    ...row,
  });

  const toCustomer = (customer) => ({
    recipient_type: 'CUSTOMER',
    recipient_customer_id: customer.id,
    recipient_address: customer.email,
  });

  const f1 = appointmentOf('F1');
  const f2 = appointmentOf('F2');
  const f6 = appointmentOf('F6');
  const f9 = appointmentOf('F9');
  const f10 = appointmentOf('F10');
  const p15 = appointmentOf('P15');

  const notifications = [
    notification(1, {
      type: 'BOOKING_CONFIRMATION',
      ...toCustomer(CUSTOMERS.ARJUN),
      appointment_id: f1.appointmentId,
      subject: 'Your deep tissue massage is confirmed',
      body: 'See you at Aurora Indiranagar.',
      payload: { appointmentPublicId: f1.publicId, studio: 'Aurora Indiranagar' },
      status: 'SENT',
      scheduled_for: f1.createdAt,
      sent_at: minutesAfter(f1.createdAt, 1),
      attempt_count: 1,
      provider_message_id: 'console-demo-0001',
      dedupe_key: 'demo:booking_confirmation:f1',
      created_at: f1.createdAt,
      updated_at: minutesAfter(f1.createdAt, 1),
    }),
    notification(2, {
      type: 'APPOINTMENT_REMINDER',
      ...toCustomer(CUSTOMERS.ARJUN),
      appointment_id: f1.appointmentId,
      subject: 'Tomorrow: deep tissue massage',
      body: null,
      status: 'PENDING',
      scheduled_for: minutesAfter(f1.startsAt, -1440),
      dedupe_key: 'demo:reminder:f1:1440',
      created_at: f1.createdAt,
      updated_at: f1.createdAt,
    }),
    notification(3, {
      type: 'APPOINTMENT_REMINDER',
      ...toCustomer(CUSTOMERS.ARJUN),
      appointment_id: f1.appointmentId,
      subject: 'Starting in two hours',
      body: null,
      status: 'PENDING',
      scheduled_for: minutesAfter(f1.startsAt, -120),
      dedupe_key: 'demo:reminder:f1:120',
      created_at: f1.createdAt,
      updated_at: f1.createdAt,
    }),
    notification(4, {
      type: 'BOOKING_RESCHEDULED',
      ...toCustomer(CUSTOMERS.NEHA),
      appointment_id: f2.appointmentId,
      subject: 'Your facial has moved to Wednesday',
      body: 'Same time, one day later.',
      status: 'SENT',
      scheduled_for: f2.rescheduledAt,
      sent_at: minutesAfter(f2.rescheduledAt, 1),
      attempt_count: 1,
      provider_message_id: 'console-demo-0002',
      dedupe_key: 'demo:rescheduled:f2',
      created_at: f2.rescheduledAt,
      updated_at: minutesAfter(f2.rescheduledAt, 1),
    }),
    notification(5, {
      type: 'BOOKING_CANCELLED',
      ...toCustomer(CUSTOMERS.DANIEL),
      appointment_id: f9.appointmentId,
      subject: 'Your appointment has been cancelled',
      body: 'The studio is closed that afternoon for its annual deep clean.',
      status: 'SENT',
      scheduled_for: f9.cancelledAt,
      sent_at: minutesAfter(f9.cancelledAt, 2),
      attempt_count: 1,
      provider_message_id: 'console-demo-0003',
      dedupe_key: 'demo:cancelled:f9',
      created_at: f9.cancelledAt,
      updated_at: minutesAfter(f9.cancelledAt, 2),
    }),
    notification(6, {
      // The reminder for a cancelled appointment is cancelled, not deleted.
      type: 'APPOINTMENT_REMINDER',
      ...toCustomer(CUSTOMERS.DANIEL),
      appointment_id: f9.appointmentId,
      subject: 'Tomorrow: aromatherapy facial',
      body: null,
      status: 'CANCELLED',
      scheduled_for: minutesAfter(f9.startsAt, -1440),
      dedupe_key: 'demo:reminder:f9:1440',
      created_at: f9.createdAt,
      updated_at: f9.cancelledAt,
    }),
    notification(7, {
      type: 'WAITLIST_SLOT_AVAILABLE',
      ...toCustomer(CUSTOMERS.DANIEL),
      waitlist_entry_id: W_DANIEL,
      subject: 'A mat has opened up on Saturday',
      body: 'Your place is held for 45 minutes.',
      status: 'SENT',
      scheduled_for: minutesAfter(now, -20),
      sent_at: minutesAfter(now, -19),
      attempt_count: 1,
      provider_message_id: 'console-demo-0004',
      dedupe_key: 'demo:waitlist:daniel',
      created_at: minutesAfter(now, -20),
      updated_at: minutesAfter(now, -19),
    }),
    notification(8, {
      type: 'OWNER_NEW_BOOKING',
      channel: 'IN_APP',
      recipient_type: 'OWNER',
      recipient_user_id: U_OWNER,
      recipient_address: PEOPLE.OWNER.email,
      appointment_id: f6.appointmentId,
      subject: 'New consultation awaiting approval',
      body: null,
      status: 'SENT',
      scheduled_for: f6.createdAt,
      sent_at: minutesAfter(f6.createdAt, 1),
      attempt_count: 1,
      dedupe_key: 'demo:owner_new_booking:f6',
      created_at: f6.createdAt,
      updated_at: minutesAfter(f6.createdAt, 1),
    }),
    notification(9, {
      type: 'APPOINTMENT_NO_SHOW',
      recipient_type: 'STAFF',
      recipient_user_id: U_RAHUL,
      recipient_address: PEOPLE.RAHUL.email,
      appointment_id: p15.appointmentId,
      subject: 'Marked as a no-show',
      body: null,
      status: 'FAILED',
      scheduled_for: minutesAfter(p15.startsAt, NO_SHOW_GRACE_MINUTES),
      failed_at: minutesAfter(p15.startsAt, NO_SHOW_GRACE_MINUTES + 30),
      attempt_count: 5,
      last_error: 'SMTP 421: service temporarily unavailable',
      dedupe_key: 'demo:no_show:p15',
      created_at: minutesAfter(p15.startsAt, NO_SHOW_GRACE_MINUTES),
      updated_at: minutesAfter(p15.startsAt, NO_SHOW_GRACE_MINUTES + 30),
    }),
    notification(10, {
      type: 'BOOKING_PENDING_APPROVAL',
      ...toCustomer(CUSTOMERS.NEHA),
      appointment_id: f10.appointmentId,
      subject: 'We have your consultation request',
      body: null,
      status: 'PROCESSING',
      scheduled_for: f10.createdAt,
      attempt_count: 1,
      dedupe_key: 'demo:pending_approval:f10',
      created_at: f10.createdAt,
      updated_at: minutesAfter(f10.createdAt, 1),
    }),
  ];

  const ownerLabel = `${PEOPLE.OWNER.name} <${PEOPLE.OWNER.email}>`;
  const p13 = appointmentOf('P13');
  const audit = (index, row) => ({
    id: id('90000000', index),
    business_id: BUSINESS,
    actor_type: 'USER',
    actor_user_id: U_OWNER,
    actor_customer_id: null,
    actor_label: ownerLabel,
    request_id: `req_demo_${String(index).padStart(4, '0')}`,
    ip_address: '203.0.113.42',
    user_agent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    metadata: {},
    ...row,
  });

  const auditLogs = [
    audit(1, {
      action: 'business.created',
      entity_type: 'business',
      entity_id: BUSINESS,
      metadata: { slug: 'aurora-wellness-studio', timezone: 'Asia/Kolkata' },
      created_at: seededAt,
    }),
    audit(2, {
      action: 'business.settings_updated',
      entity_type: 'business_settings',
      entity_id: BUSINESS,
      metadata: { changed: ['minNoticeMinutes', 'cancellationDeadlineMinutes'] },
      created_at: minutesAfter(seededAt, 12),
    }),
    audit(3, {
      action: 'role.permissions_changed',
      entity_type: 'role',
      entity_id: R_STAFF,
      metadata: { added: ['appointments:notes:manage'] },
      created_at: minutesAfter(seededAt, 30),
    }),
    audit(4, {
      action: 'membership.invited',
      entity_type: 'membership',
      entity_id: M_RAHUL,
      metadata: { email: PEOPLE.RAHUL.email, role: 'MANAGER' },
      created_at: daysBefore(now, 110),
    }),
    audit(5, {
      action: 'membership.invited',
      entity_type: 'membership',
      entity_id: M_ANANYA,
      metadata: { email: PEOPLE.ANANYA.email, role: 'STAFF' },
      created_at: daysBefore(now, 100),
    }),
    audit(6, {
      action: 'location.created',
      entity_type: 'location',
      entity_id: L_INDIRANAGAR,
      metadata: { slug: 'indiranagar' },
      created_at: minutesAfter(seededAt, 45),
    }),
    audit(7, {
      action: 'location.created',
      entity_type: 'location',
      entity_id: L_KORAMANGALA,
      metadata: { slug: 'koramangala' },
      created_at: minutesAfter(seededAt, 50),
    }),
    audit(8, {
      action: 'staff.created',
      entity_type: 'staff_profile',
      entity_id: SP_RAHUL,
      metadata: { displayName: 'Rahul Menon' },
      created_at: daysBefore(now, 109),
    }),
    audit(9, {
      action: 'service.created',
      entity_type: 'service',
      entity_id: SVC_DEEP,
      metadata: { slug: 'deep-tissue-massage', durationMinutes: 90 },
      created_at: daysBefore(now, 108),
    }),
    audit(10, {
      action: 'service.created',
      entity_type: 'service',
      entity_id: SVC_YOGA,
      metadata: { slug: 'hatha-yoga-group-class', capacity: 12 },
      created_at: daysBefore(now, 107),
    }),
    audit(11, {
      action: 'resource.created',
      entity_type: 'resource',
      entity_id: RES_ROOM_A,
      metadata: { slug: 'treatment-room-a' },
      created_at: daysBefore(now, 106),
    }),
    audit(12, {
      action: 'booking_link.created',
      entity_type: 'booking_link',
      entity_id: BL_CATALOG,
      metadata: { slug: 'aurora-wellness-studio', type: 'CATALOG' },
      created_at: daysBefore(now, 105),
    }),
    audit(13, {
      action: 'holiday.created',
      entity_type: 'holiday',
      entity_id: id('53000000', 2),
      metadata: { name: 'Independence Day' },
      created_at: daysBefore(now, 100),
    }),
    audit(14, {
      action: 'blackout.created',
      entity_type: 'blackout_period',
      entity_id: id('54000000', 1),
      metadata: { reason: 'CLOSURE' },
      created_at: daysBefore(now, 20),
    }),
    audit(15, {
      action: 'appointment.created',
      entity_type: 'appointment',
      entity_id: f1.appointmentId,
      actor_type: 'CUSTOMER',
      actor_user_id: null,
      actor_customer_id: C_ARJUN,
      actor_label: `${CUSTOMERS.ARJUN.firstName} ${CUSTOMERS.ARJUN.lastName} <${CUSTOMERS.ARJUN.email}>`,
      metadata: { source: 'PUBLIC', bookingLink: 'aurora-wellness-studio' },
      created_at: f1.createdAt,
    }),
    audit(16, {
      action: 'appointment.completed',
      entity_type: 'appointment',
      entity_id: p13.appointmentId,
      actor_user_id: U_RAHUL,
      actor_label: `${PEOPLE.RAHUL.name} <${PEOPLE.RAHUL.email}>`,
      metadata: { durationMinutes: 90 },
      created_at: p13.endsAt,
    }),
    audit(17, {
      action: 'waitlist.created',
      entity_type: 'waitlist_entry',
      entity_id: W_FATIMA,
      actor_type: 'CUSTOMER',
      actor_user_id: null,
      actor_customer_id: C_FATIMA,
      actor_label: `${CUSTOMERS.FATIMA.firstName} ${CUSTOMERS.FATIMA.lastName} <${CUSTOMERS.FATIMA.email}>`,
      metadata: { serviceSlug: 'deep-tissue-massage' },
      created_at: daysBefore(now, 6),
    }),
  ];

  // Insertion order. `down()` walks this backwards.
  return [
    { table: 'users', key: 'id', rows: users },
    { table: 'businesses', key: 'id', rows: businesses },
    { table: 'business_settings', key: 'business_id', rows: businessSettings },
    { table: 'roles', key: 'id', rows: roles },
    { table: 'role_permissions', key: 'role_id', rows: null, roleTemplates: true },
    { table: 'memberships', key: 'id', rows: memberships },
    { table: 'locations', key: 'id', rows: locations },
    { table: 'teams', key: 'id', rows: teams },
    { table: 'staff_profiles', key: 'id', rows: staffProfiles },
    { table: 'team_members', key: 'id', rows: teamMembers },
    { table: 'service_categories', key: 'id', rows: serviceCategories },
    { table: 'services', key: 'id', rows: services },
    { table: 'resources', key: 'id', rows: resources },
    { table: 'service_staff', key: 'id', rows: serviceStaff },
    { table: 'service_locations', key: 'id', rows: serviceLocations },
    { table: 'service_resource_requirements', key: 'id', rows: serviceResourceRequirements },
    { table: 'business_hours', key: 'id', rows: businessHours },
    { table: 'staff_availability_rules', key: 'id', rows: staffAvailability },
    { table: 'availability_overrides', key: 'id', rows: availabilityOverrides },
    { table: 'holidays', key: 'id', rows: holidays },
    { table: 'blackout_periods', key: 'id', rows: blackoutPeriods },
    { table: 'customers', key: 'id', rows: customers },
    { table: 'booking_links', key: 'id', rows: bookingLinks },
    { table: 'booking_link_services', key: 'id', rows: bookingLinkServices },
    { table: 'appointments', key: 'id', rows: graph.appointments },
    { table: 'appointment_staff', key: 'id', rows: graph.staffReservations },
    { table: 'appointment_participants', key: 'id', rows: graph.participants },
    { table: 'appointment_resources', key: 'id', rows: graph.resourceReservations },
    { table: 'appointment_status_history', key: 'id', rows: graph.statusHistory },
    { table: 'reschedule_history', key: 'id', rows: graph.rescheduleHistory },
    { table: 'waitlist_entries', key: 'id', rows: waitlistEntries },
    { table: 'notifications', key: 'id', rows: notifications },
    { table: 'audit_logs', key: 'id', rows: auditLogs },
  ];
}

// ---------------------------------------------------------------------------
// The four system roles, wired from the permission catalogue by key.
// Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/auth/permissions.ts.
// ---------------------------------------------------------------------------

const ALL_PERMISSION_KEYS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace:settings:manage',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'roles:read',
  'roles:manage',
  'locations:read',
  'locations:manage',
  'teams:read',
  'teams:manage',
  'staff:read',
  'staff:manage',
  'services:read',
  'services:manage',
  'resources:read',
  'resources:manage',
  'availability:read',
  'availability:manage',
  'availability:manage:own',
  'holidays:manage',
  'blackouts:manage',
  'customers:read',
  'customers:read:assigned',
  'customers:manage',
  'customers:notes:manage',
  'appointments:read',
  'appointments:read:own',
  'appointments:create',
  'appointments:update',
  'appointments:reschedule',
  'appointments:cancel',
  'appointments:complete',
  'appointments:no_show',
  'appointments:approve',
  'appointments:notes:manage',
  'booking_links:read',
  'booking_links:manage',
  'waitlist:read',
  'waitlist:manage',
  'notifications:read',
  'notifications:manage',
  'templates:manage',
  'automations:read',
  'automations:manage',
  'analytics:read',
  'reports:read',
  'reports:export',
  'audit:read',
  'webhooks:read',
  'webhooks:manage',
];

const ROLE_TEMPLATES = [
  { roleId: R_OWNER, key: 'BUSINESS_OWNER', permissions: ALL_PERMISSION_KEYS },
  {
    roleId: R_MANAGER,
    key: 'MANAGER',
    permissions: [
      'workspace:read',
      'workspace:update',
      'workspace:settings:manage',
      'members:read',
      'members:invite',
      'members:update',
      'roles:read',
      'locations:read',
      'locations:manage',
      'teams:read',
      'teams:manage',
      'staff:read',
      'staff:manage',
      'services:read',
      'services:manage',
      'resources:read',
      'resources:manage',
      'availability:read',
      'availability:manage',
      'availability:manage:own',
      'holidays:manage',
      'blackouts:manage',
      'customers:read',
      'customers:manage',
      'customers:notes:manage',
      'appointments:read',
      'appointments:create',
      'appointments:update',
      'appointments:reschedule',
      'appointments:cancel',
      'appointments:complete',
      'appointments:no_show',
      'appointments:approve',
      'appointments:notes:manage',
      'booking_links:read',
      'booking_links:manage',
      'waitlist:read',
      'waitlist:manage',
      'notifications:read',
      'notifications:manage',
      'templates:manage',
      'automations:read',
      'automations:manage',
      'analytics:read',
      'reports:read',
      'reports:export',
      'audit:read',
      'webhooks:read',
    ],
  },
  {
    roleId: R_RECEPTIONIST,
    key: 'RECEPTIONIST',
    permissions: [
      'workspace:read',
      'locations:read',
      'teams:read',
      'staff:read',
      'services:read',
      'resources:read',
      'availability:read',
      'customers:read',
      'customers:manage',
      'customers:notes:manage',
      'appointments:read',
      'appointments:create',
      'appointments:update',
      'appointments:reschedule',
      'appointments:cancel',
      'appointments:complete',
      'appointments:no_show',
      'appointments:notes:manage',
      'booking_links:read',
      'waitlist:read',
      'waitlist:manage',
      'notifications:read',
    ],
  },
  {
    roleId: R_STAFF,
    key: 'STAFF',
    permissions: [
      'workspace:read',
      'locations:read',
      'services:read',
      'staff:read',
      'availability:read',
      'availability:manage:own',
      'customers:read:assigned',
      'appointments:read:own',
      'appointments:reschedule',
      'appointments:cancel',
      'appointments:complete',
      'appointments:no_show',
      'appointments:notes:manage',
    ],
  },
];

// ---------------------------------------------------------------------------
// Insert / delete plumbing
// ---------------------------------------------------------------------------

/**
 * The columns that are genuine PostgreSQL arrays. Everything else that arrives
 * as a JS array — `custom_questions`, for instance — is a *JSON* array inside a
 * jsonb column, and the two need opposite text forms ('{a,b}' vs '[a,b]').
 */
const POSTGRES_ARRAY_COLUMNS = new Set(['tags', 'reminder_offsets_minutes', 'days_of_week']);

/**
 * Postgres infers each parameter's type from the column it is being inserted
 * into, so jsonb and array columns only need the value in its text form —
 * no explicit casts, and no string interpolation of user-visible text.
 */
function toBindValue(column, value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (POSTGRES_ARRAY_COLUMNS.has(column)) {
    const elements = value.map((element) =>
      typeof element === 'number'
        ? String(element)
        : `"${String(element).replace(/(["\\])/g, '\\$1')}"`,
    );
    return `{${elements.join(',')}}`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function insertRows(sql, transaction, table, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const expected = new Set(columns);

  // Values are read by column name, so key *order* is free — but a row missing
  // a key would be inserted as NULL without anyone noticing. Catch that here
  // rather than in a confusing not-null violation.
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length || keys.some((key) => !expected.has(key))) {
      throw new Error(
        `Demo seed row shape mismatch for ${table}: expected [${columns.join(', ')}], ` +
          `got [${keys.join(', ')}].`,
      );
    }
  }

  const binds = [];
  const tuples = rows.map((row) => {
    const slots = columns.map((column) => {
      binds.push(toBindValue(column, row[column]));
      return `$${binds.length}`;
    });
    return `(${slots.join(', ')})`;
  });

  await sql.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, {
    bind: binds,
    transaction,
  });
}

async function deleteRows(sql, transaction, table, column, values) {
  const unique = [...new Set(values)];
  if (unique.length === 0) return;
  const slots = unique.map((_, index) => `$${index + 1}`).join(', ');
  await sql.query(`DELETE FROM ${table} WHERE ${column} IN (${slots})`, {
    bind: unique,
    transaction,
  });
}

/**
 * Wires each role to its permissions by key.
 *
 * Resolving by key rather than by id keeps this correct when the catalogue was
 * created by `ensurePermissionsSeeded()` (which lets Postgres mint the ids)
 * instead of by the permissions seeder. A short row count means the catalogue
 * is incomplete, which would silently hand out a role missing abilities its
 * description promises — so it fails loudly instead.
 */
async function insertRolePermissions(sql, transaction) {
  for (const template of ROLE_TEMPLATES) {
    const slots = template.permissions.map((_, index) => `$${index + 2}`).join(', ');
    // type SELECT so the RETURNING rows come back as a plain array.
    const inserted = await sql.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE key IN (${slots})
       RETURNING permission_id`,
      { bind: [template.roleId, ...template.permissions], transaction, type: 'SELECT' },
    );

    if (inserted.length !== template.permissions.length) {
      throw new Error(
        `Permission catalogue is incomplete: role ${template.key} resolved ` +
          `${inserted.length} of ${template.permissions.length} permissions. ` +
          'Run the permissions seeder first.',
      );
    }
  }
}

module.exports = {
  async up(queryInterface) {
    assertSeedEnabled();
    const sql = queryInterface.sequelize;

    const password = process.env.SEED_DEFAULT_PASSWORD || DEFAULT_PASSWORD;
    // One hash shared by every demo account: bcrypt salts per call, so nine
    // hashes would cost nine times as much and prove nothing extra here.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const dataset = buildDataset(passwordHash, new Date());

    await sql.transaction(async (transaction) => {
      // Re-running the seeder must produce the demo tenant, not a unique-index
      // failure, so the fixed rows are removed before they are written.
      await removeDataset(sql, transaction, dataset);

      for (const entry of dataset) {
        if (entry.roleTemplates) {
          await insertRolePermissions(sql, transaction);
          continue;
        }
        await insertRows(sql, transaction, entry.table, entry.rows);
      }
    });
  },

  async down(queryInterface) {
    assertSeedEnabled();
    const sql = queryInterface.sequelize;

    // `down()` needs identifiers only, and identifiers do not depend on the
    // password, so the dataset is rebuilt without hashing anything.
    const dataset = buildDataset(null, new Date());
    await sql.transaction(async (transaction) => {
      await removeDataset(sql, transaction, dataset);
    });
  },
};

/** Deletes exactly what `up()` inserts, in reverse dependency order. */
async function removeDataset(sql, transaction, dataset) {
  for (let index = dataset.length - 1; index >= 0; index -= 1) {
    const entry = dataset[index];
    const values = entry.roleTemplates
      ? ROLE_TEMPLATES.map((template) => template.roleId)
      : entry.rows.map((row) => row[entry.key]);
    await deleteRows(sql, transaction, entry.table, entry.key, values);
  }
}
