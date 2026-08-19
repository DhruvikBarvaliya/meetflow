/**
 * Integration-test fixtures.
 *
 * Builds a complete, realistic workspace — owner, service, staff, working
 * hours — through the real service layer rather than by inserting rows, so the
 * fixtures exercise the same code paths the application uses and cannot drift
 * from it.
 */
import { sequelize } from '../../src/config/database';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentResource,
  AppointmentStaff,
  AppointmentStatusHistory,
  AuditLog,
  BlackoutPeriod,
  BookingLink,
  Business,
  Customer,
  IdempotencyKey,
  Notification,
  RefreshToken,
  Resource,
  Service,
  ServiceResourceRequirement,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
  User,
  WaitlistEntry,
} from '../../src/database/models';
import { createBusiness } from '../../src/modules/businesses/business.service';
import { hashPassword } from '../../src/utils/password';
import { slugify } from '../../src/utils/ids';

export const TEST_PASSWORD = 'Str0ngPass!2026';

let counter = 0;
/** Deterministic-but-unique suffix, so parallel fixtures cannot collide. */
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

export interface WorkspaceFixture {
  user: User;
  business: Business;
  staffProfile: StaffProfile;
  service: Service;
  customer: Customer;
}

export async function createUser(
  overrides: Partial<{ email: string; firstName: string }> = {},
): Promise<User> {
  return User.create({
    email: overrides.email ?? `${unique('user')}@meetflow.test`,
    passwordHash: await hashPassword(TEST_PASSWORD),
    firstName: overrides.firstName ?? 'Test',
    lastName: 'User',
    phone: null,
    avatarUrl: null,
    timezone: 'UTC',
    emailVerifiedAt: new Date(),
    emailVerificationTokenHash: null,
    emailVerificationSentAt: null,
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    lastLoginAt: null,
    lockedUntil: null,
  });
}

/**
 * Marks an account's address as confirmed.
 *
 * Arrangement, not assertion. `requireVerifiedEmail` guards the management API,
 * so a test that registers through `POST /auth/register` and then calls
 * anything else has to get past it — and walking the real link every time would
 * mean every file reproducing the outbox lookup to test something unrelated to
 * verification.
 *
 * `emailVerification.test.ts` is where the real flow is exercised end to end,
 * including the refusal this bypasses. Everywhere else, this is the equivalent
 * of the user having clicked the link before the test began.
 */
export async function markEmailVerified(email: string): Promise<void> {
  await User.update({ emailVerifiedAt: new Date() }, { where: { email } });
}

/**
 * A workspace ready to take bookings.
 *
 * Working hours are Mon–Fri 09:00–17:00 in `timezone` (created by
 * createBusiness), and the owner's staff profile is given matching
 * availability rules so slots actually exist.
 */
export async function createWorkspace(
  options: {
    timezone?: string;
    serviceDurationMinutes?: number;
    serviceCapacity?: number;
    preBufferMinutes?: number;
    postBufferMinutes?: number;
    minNoticeMinutes?: number;
    slotIntervalMinutes?: number;
  } = {},
): Promise<WorkspaceFixture> {
  const timezone = options.timezone ?? 'UTC';
  const user = await createUser();

  const { business, staffProfile } = await createBusiness(
    user.id,
    { name: unique('Clinic'), timezone },
    { requestId: 'fixture', ipAddress: null, userAgent: null },
  );

  if (!staffProfile) throw new Error('fixture expected a staff profile');

  const service = await Service.create({
    businessId: business.id,
    categoryId: null,
    name: 'Consultation',
    slug: slugify(unique('consultation')),
    description: null,
    durationMinutes: options.serviceDurationMinutes ?? 30,
    preBufferMinutes: options.preBufferMinutes ?? null,
    postBufferMinutes: options.postBufferMinutes ?? null,
    priceAmount: 5000,
    capacity: options.serviceCapacity ?? 1,
    minNoticeMinutes: options.minNoticeMinutes ?? 0,
    maxHorizonDays: null,
    slotIntervalMinutes: options.slotIntervalMinutes ?? 30,
    maxPerCustomerPerDay: null,
    color: null,
  });

  await ServiceStaff.create({
    serviceId: service.id,
    staffProfileId: staffProfile.id,
    durationMinutesOverride: null,
    priceAmountOverride: null,
  });

  // Mon–Fri 09:00–17:00, matching the default business hours.
  await StaffAvailabilityRule.bulkCreate(
    [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      businessId: business.id,
      staffProfileId: staffProfile.id,
      locationId: null,
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      effectiveFrom: null,
      effectiveTo: null,
    })),
  );

  const customer = await Customer.create({
    businessId: business.id,
    publicId: unique('cus'),
    userId: null,
    firstName: 'Ada',
    lastName: 'Customer',
    email: `${unique('customer')}@meetflow.test`,
    phone: null,
    timezone,
    notes: null,
    preferredStaffProfileId: null,
    preferredLocationId: null,
    firstAppointmentAt: null,
    lastAppointmentAt: null,
  });

  return { user, business, staffProfile, service, customer };
}

/**
 * The next occurrence of `hour:00` local time on a weekday, at least
 * `minDaysAhead` days out — so tests are never affected by the day they run on
 * or by the minimum-notice policy.
 */
export function nextWeekdayAt(hourUtc: number, minDaysAhead = 3, from: Date = new Date()): Date {
  const candidate = new Date(from.getTime());
  candidate.setUTCDate(candidate.getUTCDate() + minDaysAhead);
  candidate.setUTCHours(hourUtc, 0, 0, 0);
  // Skip Saturday (6) and Sunday (0): the fixture only works Mon–Fri.
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/**
 * Truncates every domain table between tests.
 *
 * RESTART IDENTITY CASCADE in one statement is far faster than per-model
 * destroy() and cannot leave orphans behind.
 */
export async function resetDatabase(): Promise<void> {
  const tables = [
    AuditLog,
    Notification,
    AppointmentStatusHistory,
    AppointmentResource,
    AppointmentParticipant,
    AppointmentStaff,
    WaitlistEntry,
    Appointment,
    IdempotencyKey,
    BookingLink,
    ServiceResourceRequirement,
    ServiceStaff,
    Service,
    Resource,
    StaffAvailabilityRule,
    BlackoutPeriod,
    Customer,
    StaffProfile,
    RefreshToken,
    Business,
    User,
  ]
    .map((model) => `"${model.getTableName() as string}"`)
    .join(', ');

  await sequelize.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`);
}

export async function closeDatabaseConnection(): Promise<void> {
  await sequelize.close();
}
