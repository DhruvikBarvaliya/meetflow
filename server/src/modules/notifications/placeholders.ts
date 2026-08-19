/**
 * What a workspace may write inside `{{ }}` in each message, and what happens
 * when it writes something else.
 *
 * `renderTemplate` substitutes an unknown placeholder with an empty string. On
 * a built-in template that is harmless, because the built-ins and the producers
 * were written together. On a template an operator edits it is the whole risk
 * of the feature: `{{cusotmerName}}` is a typo no type-checker sees, and the
 * result is an email that opens "Hi ," to every customer the workspace has,
 * with nothing logged and nothing to notice until somebody replies to complain.
 *
 * So the catalogue below is a **contract, not documentation**. Saving a
 * template is refused when it names a placeholder that will not be there, and
 * the refusal says which one and lists what is available.
 *
 * The lists are derived from the producers, not from the built-in defaults, and
 * they are deliberately the *intersection* where a key has more than one
 * producer. `APPOINTMENT_REMINDER` is the case that matters: booking queues it
 * with the payload built in `booking.service.ts`, and a reschedule re-queues it
 * with the payload built in `lifecycle.service.ts`, which carries one extra
 * field. Promising that field would make it available on a reminder for a
 * booking nobody ever moved and empty on one they did — the worst kind of
 * intermittent, because the operator's own test send would show it working.
 *
 * `notificationPlaceholderDrift.test.ts` books, cancels, moves and rejects real
 * appointments and asserts every name here is present in the payload that
 * actually reaches the outbox, so a producer that drops a field fails a test
 * rather than quietly emptying a placeholder in production.
 */
import type { NotificationTemplateKey } from '../../database/models/NotificationTemplate';

/**
 * Present on every message about one appointment.
 *
 * `enqueueBookingNotifications` in `booking.service.ts` and `buildPayload` in
 * `lifecycle.service.ts` build this object separately; that duplication is why
 * the drift test exercises both paths rather than one.
 */
const APPOINTMENT_BASE = [
  'customerName',
  'businessName',
  'serviceName',
  'staffName',
  'locationName',
  'startsAtLocal',
  'timezone',
  'durationMinutes',
  'manageUrl',
  'bookingUrl',
  'dashboardUrl',
] as const;

/**
 * One line of help per placeholder, shown beside the editor.
 *
 * Written for the person editing the copy, not for the developer reading the
 * payload: "the provider's display name" rather than "staffProfile.displayName".
 */
export const PLACEHOLDER_DESCRIPTIONS: Record<string, string> = {
  customerName: 'The customer’s name, or “there” when the booking has no customer record.',
  businessName: 'Your workspace name.',
  serviceName: 'The service booked.',
  staffName: 'The provider’s display name.',
  locationName: 'The site, or “Online” for a virtual appointment.',
  startsAtLocal: 'The start time, written out in the recipient’s time zone.',
  timezone: 'The time zone the times above are written in.',
  durationMinutes: 'How long the appointment runs, in minutes.',
  manageUrl: 'The customer’s link to view, move or cancel this appointment.',
  bookingUrl: 'Your public booking page.',
  dashboardUrl: 'The staff schedule inside MeetFlow.',
  reason: 'The reason given for the cancellation or rejection. Empty when none was given.',
  previousStartsAtLocal: 'The time the appointment was moved from.',
  changeSummary: 'A short description of what changed in the provider’s diary.',
  claimUrl: 'The waitlist offer’s claim link.',
  holdExpiresAtLocal: 'When the waitlist hold on the offered opening runs out.',
  earliestDate: 'The earliest date the customer said they could attend.',
  latestDate: 'The latest date the customer said they could attend.',
  appointmentCount: 'How many appointments the day holds.',
  firstAppointmentLocal: 'The day’s first start time.',
  lastAppointmentLocal: 'The day’s last start time.',
};

/**
 * The placeholders each message is guaranteed to be able to fill.
 *
 * A key missing from this map is a key nothing may be written for, which is why
 * the map is exhaustive over `NotificationTemplateKey` by type rather than by
 * convention — adding a seventeenth template key fails to compile until its
 * placeholders are declared.
 */
export const TEMPLATE_PLACEHOLDERS: Record<NotificationTemplateKey, readonly string[]> = {
  BOOKING_CONFIRMATION: APPOINTMENT_BASE,
  BOOKING_PENDING_APPROVAL: APPOINTMENT_BASE,
  BOOKING_APPROVED: [...APPOINTMENT_BASE, 'reason'],
  BOOKING_REJECTED: [...APPOINTMENT_BASE, 'reason'],
  BOOKING_CANCELLED: [...APPOINTMENT_BASE, 'reason'],
  BOOKING_RESCHEDULED: [...APPOINTMENT_BASE, 'reason', 'previousStartsAtLocal'],
  // Queued from two places with two payloads. The intersection is the promise.
  APPOINTMENT_REMINDER: APPOINTMENT_BASE,
  APPOINTMENT_FOLLOW_UP: APPOINTMENT_BASE,
  APPOINTMENT_NO_SHOW: [...APPOINTMENT_BASE, 'reason'],
  CUSTOMER_WELCOME: APPOINTMENT_BASE,
  STAFF_ASSIGNED: APPOINTMENT_BASE,
  STAFF_SCHEDULE_CHANGED: [...APPOINTMENT_BASE, 'reason', 'changeSummary'],
  OWNER_NEW_BOOKING: APPOINTMENT_BASE,
  // The one message nothing queues: it needs a scheduled job that does not
  // exist, which `docs/ProductRequirements.md` §6 records. Its placeholders are
  // declared from the built-in default so the editor and the validator agree,
  // and the drift test skips it by name through
  // `TEMPLATE_KEYS_WITHOUT_PRODUCERS` rather than by silence — so wiring a
  // producer later is not free of obligations.
  OWNER_DAILY_DIGEST: [
    'businessName',
    'appointmentCount',
    'firstAppointmentLocal',
    'lastAppointmentLocal',
    'dashboardUrl',
  ],
  WAITLIST_SLOT_AVAILABLE: [
    'customerName',
    'businessName',
    'serviceName',
    'startsAtLocal',
    'timezone',
    'holdExpiresAtLocal',
    'claimUrl',
  ],
  WAITLIST_CONFIRMED: ['customerName', 'businessName', 'serviceName', 'earliestDate', 'latestDate'],
};

/** Template keys nothing enqueues yet, so the drift test knows not to look. */
export const TEMPLATE_KEYS_WITHOUT_PRODUCERS: readonly NotificationTemplateKey[] = [
  'OWNER_DAILY_DIGEST',
];

/** Every `{{name}}` in a body, in the order written, without duplicates. */
export function placeholdersUsed(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found];
}

/**
 * The placeholders in `template` that this key cannot fill.
 *
 * Empty means the template is safe to save. Anything else is a name that would
 * render as nothing at all.
 */
export function unknownPlaceholders(key: NotificationTemplateKey, template: string): string[] {
  const allowed = new Set<string>(TEMPLATE_PLACEHOLDERS[key]);
  return placeholdersUsed(template).filter((name) => !allowed.has(name));
}

/**
 * Believable values for every placeholder, for previewing a draft.
 *
 * Deliberately not "Lorem ipsum" and not `{{customerName}}` echoed back: an
 * operator judging whether a message reads well needs it to read like a message,
 * and a preview full of obvious filler gets skimmed rather than read.
 */
export const PREVIEW_SAMPLE: Record<string, string | number> = {
  customerName: 'Priya Shah',
  businessName: 'Riverside Clinic',
  serviceName: 'Physiotherapy consultation',
  staffName: 'Dr Anjali Rao',
  locationName: 'Riverside Clinic — Room 2',
  startsAtLocal: 'Tuesday, 14 April 2026 at 10:00 am',
  previousStartsAtLocal: 'Monday, 13 April 2026 at 4:30 pm',
  timezone: 'Asia/Kolkata',
  durationMinutes: 45,
  manageUrl: 'https://app.meetflow.test/appointments/apt_preview',
  bookingUrl: 'https://app.meetflow.test/b/riverside-clinic',
  dashboardUrl: 'https://app.meetflow.test/app/schedule',
  reason: 'A scheduling conflict came up.',
  changeSummary: 'Moved from 4:30 pm to 10:00 am.',
  claimUrl: 'https://app.meetflow.test/waitlist/wl_preview',
  holdExpiresAtLocal: 'Tuesday, 14 April 2026 at 11:00 am',
  earliestDate: '2026-04-13',
  latestDate: '2026-04-20',
  appointmentCount: 7,
  firstAppointmentLocal: '9:00 am',
  lastAppointmentLocal: '5:30 pm',
};
