#!/usr/bin/env node
/**
 * Fills a local stack with businesses that are actually different from each
 * other.
 *
 * The seeded Aurora Wellness Studio is one carefully-built workspace, and the
 * e2e suite leaves behind dozens of copies of one shape. Neither shows what the
 * product looks like across the range of businesses it is for — a barber taking
 * twenty-minute walk-ins has almost nothing in common with a consultancy
 * selling ninety-minute video calls, and the screens that matter (the diary,
 * availability, analytics, the public page) look genuinely different for each.
 *
 * So this creates six workspaces that differ where it counts: appointment
 * length, group capacity, whether bookings need approving, physical versus
 * virtual, one practitioner versus five, currency, time zone, buffers, and
 * notice periods.
 *
 * **Built through the API, not through SQL.** Every workspace here is created
 * by the same endpoints a real client calls, so the data cannot be a state the
 * application could not produce: services pass their own validation, staff get
 * real availability rules, and every appointment goes through the slot engine
 * and lands inside the same exclusion constraint that guards production. A
 * seeder writing rows directly can — and historically does — invent data no
 * user could have created, which then makes a screen look fine against
 * something it will never actually receive.
 *
 * The one exception is deliberate and marked: appointments in the **past**.
 * `POST /bookings` refuses them, correctly, so a handful of rows are booked
 * ahead and then aged backwards with SQL to give the diary a history and the
 * analytics something to add up. `appointments_buffer_check` means the buffer
 * columns have to move with the window; the code says so where it does it.
 *
 *   node scripts/demo-data.mjs            # add the six workspaces
 *   node scripts/demo-data.mjs --reset    # wipe everything first, then seed + add
 *
 * Local only. It refuses to run against a production configuration, and it
 * needs the dev stack already running.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadEnv() {
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* A missing .env is fine; the defaults below cover a stock compose stack. */
  }
}

loadEnv();

if (process.env.APP_ENV === 'production') {
  console.error('Refusing to run against APP_ENV=production.');
  process.exit(1);
}

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000';
const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'MeetFlow!Demo123';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://meetflow:meetflow@localhost:5432/meetflow_dev';

/**
 * Mutable, because `--reset` has to close this before shelling out to
 * `db:reset` — the migration drops every table and will not do it while a
 * connection is holding them — and a `pg.Client` cannot be reconnected once
 * ended. A fresh one is made on the far side.
 */
let db = new pg.Client({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function call(path, { method = 'GET', token, businessId, body, idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (businessId) headers['X-Business-Id'] = businessId;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      `${method} ${path} -> ${response.status} ${payload?.error?.code ?? ''} ` +
        `${payload?.error?.message ?? text}`,
    );
  }
  return payload?.data;
}

/**
 * Registers an owner and confirms the address.
 *
 * Verification is enforced, so an unconfirmed owner can do nothing at all. The
 * link is read out of the outbox and used, rather than the column being
 * stamped — same reasoning as `e2e/fixtures/verification.ts`: it costs one
 * query and it means this script exercises the real endpoint instead of
 * assuming it works.
 */
async function registerOwner(email, firstName, lastName) {
  const session = await call('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, firstName, lastName, timezone: 'Asia/Kolkata' },
  });

  const { rows } = await db.query(
    `SELECT payload FROM notifications
      WHERE type = 'EMAIL_VERIFICATION' AND lower(recipient_address) = lower($1)
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const url = rows[0]?.payload?.verificationUrl;
  if (!url) throw new Error(`No verification email was queued for ${email}.`);
  const token = new URL(url).searchParams.get('token');
  await call('/api/v1/auth/verify-email', { method: 'POST', body: { token } });

  return session.accessToken;
}

// ---------------------------------------------------------------------------
// The businesses
//
// Each entry is a whole workspace: who runs it, where it works from, what it
// sells and to whom. The variety is the point — read down any one column and
// the values should look nothing alike.
// ---------------------------------------------------------------------------

const WORKSPACES = [
  {
    slug: 'northgate-dental',
    name: 'Northgate Dental Practice',
    industry: 'Dental',
    timezone: 'Europe/London',
    currency: 'GBP',
    locale: 'en-GB',
    description: 'A three-surgery NHS and private dental practice in north Leeds.',
    owner: { email: 'helen.whitcombe@northgatedental.test', first: 'Helen', last: 'Whitcombe' },
    // Approval on: a dental practice triages before it commits a surgery.
    settings: {
      requireApproval: true,
      minNoticeMinutes: 24 * 60,
      cancellationDeadlineMinutes: 48 * 60,
    },
    locations: [
      { name: 'Northgate Surgery', type: 'PHYSICAL', city: 'Leeds', addressLine1: '14 Northgate' },
    ],
    staff: [
      { first: 'Helen', last: 'Whitcombe', title: 'Principal Dentist', owner: true },
      { first: 'Omar', last: 'Haddad', title: 'Associate Dentist' },
      { first: 'Bridget', last: 'Nwosu', title: 'Dental Hygienist' },
    ],
    hours: { days: [1, 2, 3, 4, 5], start: '08:30', end: '17:30' },
    services: [
      { name: 'Routine examination', minutes: 20, price: 3_500, interval: 20 },
      { name: 'Hygienist appointment', minutes: 30, price: 6_500, interval: 30 },
      { name: 'Filling', minutes: 45, price: 12_000, interval: 15, preBuffer: 5, postBuffer: 10 },
      { name: 'Emergency appointment', minutes: 20, price: 8_000, interval: 20, minNotice: 0 },
    ],
    links: [{ name: 'Book with Northgate', slug: 'northgate-dental', type: 'CATALOG' }],
    customers: 14,
    appointments: { past: 18, upcoming: 12 },
  },
  {
    slug: 'the-fade-room',
    name: 'The Fade Room',
    industry: 'Barbering',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
    description: 'Three chairs, no appointments longer than half an hour, open six days.',
    owner: { email: 'dev.raghunath@thefaderoom.test', first: 'Dev', last: 'Raghunath' },
    // The opposite end from the dentist: walk-in pace, book up to an hour out.
    settings: { requireApproval: false, minNoticeMinutes: 60, cancellationDeadlineMinutes: 120 },
    locations: [
      { name: 'Indiranagar', type: 'PHYSICAL', city: 'Bengaluru', addressLine1: '100 Feet Road' },
    ],
    staff: [
      { first: 'Dev', last: 'Raghunath', title: 'Master Barber', owner: true },
      { first: 'Sanjay', last: 'Pillai', title: 'Barber' },
      { first: 'Ritu', last: 'Kaur', title: 'Barber' },
    ],
    hours: { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '20:00' },
    services: [
      { name: 'Skin fade', minutes: 30, price: 60_000, interval: 30 },
      { name: 'Beard trim', minutes: 20, price: 35_000, interval: 20 },
      { name: 'Cut and beard', minutes: 45, price: 90_000, interval: 15 },
      { name: 'Hot towel shave', minutes: 30, price: 55_000, interval: 30 },
    ],
    links: [{ name: 'Book a chair', slug: 'the-fade-room', type: 'CATALOG' }],
    customers: 20,
    appointments: { past: 30, upcoming: 18 },
  },
  {
    slug: 'clearwater-physio',
    name: 'Clearwater Physiotherapy',
    industry: 'Physiotherapy',
    timezone: 'Australia/Sydney',
    currency: 'AUD',
    locale: 'en-AU',
    description: 'Musculoskeletal physiotherapy across two clinics on the northern beaches.',
    owner: { email: 'marcus.oyelaran@clearwaterphysio.test', first: 'Marcus', last: 'Oyelaran' },
    // Waitlist on, because a physio's diary fills and cancellations are gold.
    settings: { waitlistEnabled: true, minNoticeMinutes: 4 * 60, maxHorizonDays: 60 },
    locations: [
      { name: 'Manly Clinic', type: 'PHYSICAL', city: 'Sydney', addressLine1: '3 Whistler Street' },
      {
        name: 'Dee Why Clinic',
        type: 'PHYSICAL',
        city: 'Sydney',
        addressLine1: '812 Pittwater Road',
      },
    ],
    staff: [
      { first: 'Marcus', last: 'Oyelaran', title: 'Principal Physiotherapist', owner: true },
      { first: 'Ingrid', last: 'Bakke', title: 'Physiotherapist' },
    ],
    hours: { days: [1, 2, 3, 4, 5], start: '07:00', end: '15:00' },
    services: [
      { name: 'Initial assessment', minutes: 60, price: 14_000, interval: 30, postBuffer: 10 },
      { name: 'Follow-up treatment', minutes: 30, price: 9_000, interval: 30 },
      { name: 'Dry needling', minutes: 45, price: 11_500, interval: 15 },
    ],
    links: [{ name: 'Book physiotherapy', slug: 'clearwater-physio', type: 'CATALOG' }],
    customers: 16,
    appointments: { past: 22, upcoming: 14 },
  },
  {
    slug: 'lighthouse-tutoring',
    name: 'Lighthouse Tutoring',
    industry: 'Education',
    timezone: 'America/New_York',
    currency: 'USD',
    locale: 'en-US',
    description: 'Small-group maths and science tuition, evenings and weekends, online.',
    owner: { email: 'nadia.strand@lighthousetutoring.test', first: 'Nadia', last: 'Strand' },
    settings: { requireApproval: false, minNoticeMinutes: 12 * 60 },
    // Entirely virtual, which is a different public page and a different diary.
    locations: [
      {
        name: 'Online',
        type: 'VIRTUAL',
        virtualMeetingUrl: 'https://meet.lighthousetutoring.test/room',
      },
    ],
    staff: [
      { first: 'Nadia', last: 'Strand', title: 'Founder & Tutor', owner: true },
      { first: 'Tobias', last: 'Fenn', title: 'Physics Tutor' },
    ],
    // Evenings only — the availability screen looks nothing like the others'.
    hours: { days: [1, 2, 3, 4, 5], start: '16:00', end: '21:00' },
    services: [
      // Group capacity: one appointment, many participants.
      { name: 'GCSE Maths — small group', minutes: 60, price: 3_000, interval: 60, capacity: 6 },
      {
        name: 'A-Level Physics — small group',
        minutes: 90,
        price: 4_500,
        interval: 30,
        capacity: 4,
      },
      { name: 'One-to-one tuition', minutes: 60, price: 8_000, interval: 60 },
    ],
    links: [{ name: 'Join a class', slug: 'lighthouse-tutoring', type: 'CATALOG' }],
    customers: 18,
    appointments: { past: 14, upcoming: 16 },
  },
  {
    slug: 'sterling-advisory',
    name: 'Sterling & Co Advisory',
    industry: 'Professional Services',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    locale: 'de-DE',
    description: 'One partner, long conversations, everything by video.',
    owner: { email: 'anneke.vermeer@sterlingadvisory.test', first: 'Anneke', last: 'Vermeer' },
    // A single practitioner selling her own time: long notice, generous buffers.
    settings: { requireApproval: true, minNoticeMinutes: 48 * 60, maxHorizonDays: 90 },
    locations: [
      {
        name: 'Video call',
        type: 'VIRTUAL',
        virtualMeetingUrl: 'https://meet.sterlingadvisory.test/anneke',
      },
    ],
    staff: [{ first: 'Anneke', last: 'Vermeer', title: 'Managing Partner', owner: true }],
    hours: { days: [2, 3, 4], start: '09:00', end: '16:00' },
    services: [
      {
        name: 'Discovery call',
        minutes: 30,
        price: 0,
        interval: 30,
        postBuffer: 15,
        minNotice: 24 * 60,
      },
      {
        name: 'Strategy session',
        minutes: 90,
        price: 45_000,
        interval: 30,
        preBuffer: 15,
        postBuffer: 15,
      },
    ],
    links: [{ name: 'Talk to Anneke', slug: 'sterling-advisory', type: 'CATALOG' }],
    customers: 9,
    appointments: { past: 8, upcoming: 6 },
  },
  {
    slug: 'harbour-veterinary',
    name: 'Harbour Veterinary Clinic',
    industry: 'Veterinary',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
    description: 'Small-animal practice with a busy Saturday morning clinic.',
    owner: { email: 'prakash.iyengar@harbourvet.test', first: 'Prakash', last: 'Iyengar' },
    settings: { requireApproval: false, minNoticeMinutes: 2 * 60, waitlistEnabled: true },
    locations: [
      { name: 'Harbour Clinic', type: 'PHYSICAL', city: 'Kochi', addressLine1: 'Marine Drive' },
    ],
    staff: [
      { first: 'Prakash', last: 'Iyengar', title: 'Senior Veterinarian', owner: true },
      { first: 'Meera', last: 'Chandran', title: 'Veterinarian' },
      { first: 'Joseph', last: 'Aloysius', title: 'Veterinary Nurse' },
    ],
    // Six days including a short Saturday — a shape none of the others have.
    hours: { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00' },
    services: [
      { name: 'Consultation', minutes: 20, price: 70_000, interval: 20 },
      { name: 'Vaccination', minutes: 15, price: 90_000, interval: 15 },
      { name: 'Dental scale and polish', minutes: 60, price: 350_000, interval: 30, preBuffer: 10 },
      { name: 'Nail clip', minutes: 15, price: 30_000, interval: 15 },
    ],
    links: [{ name: 'Book your pet in', slug: 'harbour-veterinary', type: 'CATALOG' }],
    customers: 22,
    appointments: { past: 26, upcoming: 20 },
  },
];

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Aisha',
  'Bartholomew',
  'Camila',
  'Dmitri',
  'Eleni',
  'Farid',
  'Grace',
  'Hassan',
  'Ilona',
  'Jonas',
  'Keiko',
  'Lucia',
  'Mateo',
  'Nadia',
  'Oskar',
  'Priya',
  'Quentin',
  'Rosa',
  'Samuel',
  'Tanvi',
  'Ulrich',
  'Valentina',
  'Wren',
  'Xiomara',
  'Yusuf',
  'Zara',
  'Aditi',
  'Bruno',
  'Chidi',
  'Delphine',
];
const LAST_NAMES = [
  'Abernathy',
  'Bhatt',
  'Costa',
  'Dlamini',
  'Eriksen',
  'Fitzgerald',
  'Gupta',
  'Halvorsen',
  'Ibrahim',
  'Jankowski',
  'Kaur',
  'Lindqvist',
  'Moreau',
  'Nakamura',
  'Okonkwo',
  'Petrov',
  'Quiroga',
  'Rasmussen',
  'Silva',
  'Tremblay',
  'Ueda',
  'Vargas',
  'Whitfield',
  'Xu',
  'Yilmaz',
  'Zawadzki',
  'Anand',
  'Boateng',
  'Cardoso',
  'Duarte',
];

let personCounter = 0;
function person() {
  const first = FIRST_NAMES[personCounter % FIRST_NAMES.length];
  const last = LAST_NAMES[(personCounter * 7) % LAST_NAMES.length];
  personCounter += 1;
  return { first, last, index: personCounter };
}

// ---------------------------------------------------------------------------
// Building one workspace
// ---------------------------------------------------------------------------

async function buildWorkspace(spec) {
  process.stdout.write(`\n  ${spec.name}\n`);

  const token = await registerOwner(spec.owner.email, spec.owner.first, spec.owner.last);
  const created = await call('/api/v1/workspaces', {
    method: 'POST',
    token,
    body: {
      name: spec.name,
      slug: spec.slug,
      timezone: spec.timezone,
      currency: spec.currency,
      locale: spec.locale,
      industry: spec.industry,
      description: spec.description,
      createStaffProfile: true,
    },
  });

  const businessId = created.business.id;
  const ctx = { token, businessId };
  process.stdout.write('    workspace\n');

  // --- Policy ------------------------------------------------------------
  if (spec.settings) {
    await call('/api/v1/workspace/settings', { ...ctx, method: 'PATCH', body: spec.settings });
  }

  // --- Locations ---------------------------------------------------------
  const locations = [];
  for (const location of spec.locations) {
    locations.push(
      await call('/api/v1/locations', {
        ...ctx,
        method: 'POST',
        body: { ...location, timezone: spec.timezone },
      }),
    );
  }
  process.stdout.write(`    ${locations.length} location(s)\n`);

  // --- Staff -------------------------------------------------------------
  //
  // The owner already has a profile from `createStaffProfile`. Colleagues are
  // invited and their invitations accepted, because that is the only way a
  // membership becomes ACTIVE — and an inactive membership cannot hold a
  // bookable staff profile.
  const roles = await call('/api/v1/workspace/roles', ctx);
  const staffRole = roles.find((role) => role.key === 'STAFF');

  const staffProfiles = [];
  for (const member of spec.staff) {
    if (member.owner) {
      const mine = await call('/api/v1/staff?pageSize=50', ctx);
      const own = mine.find(() => true);
      if (own) {
        await call(`/api/v1/staff/${own.id}`, {
          ...ctx,
          method: 'PATCH',
          body: { displayName: `${member.first} ${member.last}`, title: member.title },
        });
        staffProfiles.push({ ...own, displayName: `${member.first} ${member.last}` });
      }
      continue;
    }

    const email = `${member.first}.${member.last}@${spec.slug}.test`.toLowerCase();
    const colleagueToken = await registerOwner(email, member.first, member.last);
    await call('/api/v1/members/invite', {
      ...ctx,
      method: 'POST',
      body: { email, roleId: staffRole.id },
    });
    const invitations = await call('/api/v1/members/invitations', { token: colleagueToken });
    await call('/api/v1/members/accept', {
      method: 'POST',
      token: colleagueToken,
      body: { token: invitations[0].token },
    });

    const members = await call('/api/v1/members?pageSize=50', ctx);
    // The account is nested under `user`; the membership id is the row's own.
    const membership = members.find((row) => row.user?.email?.toLowerCase() === email);
    if (!membership) throw new Error(`${email} accepted but is not in the member list.`);
    const profile = await call('/api/v1/staff', {
      ...ctx,
      method: 'POST',
      body: {
        membershipId: membership.id,
        displayName: `${member.first} ${member.last}`,
        title: member.title,
        timezone: spec.timezone,
      },
    });
    staffProfiles.push(profile);
  }
  process.stdout.write(`    ${staffProfiles.length} staff\n`);

  // --- Availability ------------------------------------------------------
  for (const profile of staffProfiles) {
    await call(`/api/v1/availability/staff/${profile.id}/rules`, {
      ...ctx,
      method: 'PUT',
      body: {
        rules: spec.hours.days.map((dayOfWeek) => ({
          dayOfWeek,
          startTime: spec.hours.start,
          endTime: spec.hours.end,
        })),
      },
    });
  }

  // --- Services ----------------------------------------------------------
  const services = [];
  for (const service of spec.services) {
    const row = await call('/api/v1/services', {
      ...ctx,
      method: 'POST',
      body: {
        name: service.name,
        durationMinutes: service.minutes,
        priceAmount: service.price,
        capacity: service.capacity ?? 1,
        slotIntervalMinutes: service.interval,
        ...(service.preBuffer ? { preBufferMinutes: service.preBuffer } : {}),
        ...(service.postBuffer ? { postBufferMinutes: service.postBuffer } : {}),
        ...(service.minNotice !== undefined ? { minNoticeMinutes: service.minNotice } : {}),
      },
    });
    // Everybody can deliver everything, which keeps Smart Match interesting
    // without needing a per-service roster in the spec above.
    await call(`/api/v1/services/${row.id}/staff`, {
      ...ctx,
      method: 'PUT',
      body: { staffProfileIds: staffProfiles.map((profile) => profile.id) },
    });
    services.push(row);
  }
  process.stdout.write(`    ${services.length} services\n`);

  // --- Booking links -----------------------------------------------------
  const links = [];
  for (const link of spec.links) {
    links.push(
      await call('/api/v1/booking-links', {
        ...ctx,
        method: 'POST',
        // The slug is set explicitly rather than derived from the link's name.
        // Left to itself the generator produces `book-with-northgate` from the
        // *name*, which is fine but unguessable — and the whole point of these
        // workspaces is that somebody can open one without looking it up.
        body: { name: link.name, slug: link.slug, type: link.type },
      }),
    );
  }

  // --- Customers ---------------------------------------------------------
  const customers = [];
  for (let index = 0; index < spec.customers; index += 1) {
    const who = person();
    customers.push(
      await call('/api/v1/customers', {
        ...ctx,
        method: 'POST',
        body: {
          firstName: who.first,
          lastName: who.last,
          email: `${who.first}.${who.last}.${who.index}@example.test`.toLowerCase(),
          phone: `+9198${String(40_000_000 + who.index * 137).slice(0, 8)}`,
        },
      }),
    );
  }
  process.stdout.write(`    ${customers.length} customers\n`);

  return { spec, token, businessId, ctx, services, staffProfiles, locations, links, customers };
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * Books against real openings, so every appointment sits where the engine says
 * it can.
 *
 * Slots are fetched per service and consumed in order; when a service runs out
 * of offerings the loop moves on rather than forcing a booking the engine has
 * not offered, which is how a demo ends up with two appointments in one chair.
 */
async function bookUpcoming(workspace, count) {
  const { ctx, services, customers } = workspace;
  const from = new Date();
  const to = new Date(Date.now() + 21 * 86_400_000);
  const made = [];
  const reported = new Set();

  let customerIndex = 0;
  for (const service of services) {
    if (made.length >= count) break;

    let slots = [];
    try {
      const found = await call(
        // Under /appointments, not /availability: reading what *could* be
        // booked is a diary question in this API's shape, and the contract in
        // docs/openapi.json is the authority on that.
        `/api/v1/appointments/availability/slots?serviceId=${service.id}` +
          `&fromDate=${from.toISOString().slice(0, 10)}` +
          `&toDate=${to.toISOString().slice(0, 10)}` +
          `&timezone=${encodeURIComponent(workspace.spec.timezone)}`,
        ctx,
      );
      slots = found.slots ?? found;
    } catch (error) {
      process.stdout.write(`      (${service.name}: no slots — ${error.message})
`);
      continue;
    }
    if (slots.length === 0) {
      process.stdout.write(`      (${service.name}: the engine offered nothing)
`);
    }

    const perService = Math.ceil(count / services.length);
    for (const slot of slots.slice(0, perService)) {
      if (made.length >= count) break;
      const customer = customers[customerIndex % customers.length];
      customerIndex += 1;
      try {
        const appointment = await call('/api/v1/appointments', {
          ...ctx,
          method: 'POST',
          body: {
            serviceId: service.id,
            staffProfileId: slot.staffProfileId,
            startsAt: slot.startsAt,
            timezone: workspace.spec.timezone,
            // `id` names the existing record; the rest is what the endpoint
            // needs to create one when it does not, and it is the same person
            // either way.
            customer: {
              id: customer.id,
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
            },
          },
        });
        // The endpoint answers with `{ appointment, participant, customer }`,
        // not a bare appointment. Reading `.id` off the envelope yields
        // `undefined`, and an UPDATE keyed on undefined matches nothing and
        // says nothing — which is exactly how the first run of this script
        // reported ageing 15 rows and moved none.
        made.push(appointment.appointment);
      } catch (error) {
        // A slot taken between the search and the write is exactly what the
        // exclusion constraint is for, and skipping it is right. Reporting the
        // first failure per service is not optional though: swallowing all of
        // them is how this script "succeeds" having booked nothing, which is
        // precisely what it did on its first run.
        if (!reported.has(service.id)) {
          reported.add(service.id);
          process.stdout.write(`      (${service.name}: ${error.message})
`);
        }
      }
    }
  }
  return made;
}

/**
 * Gives the workspace a history.
 *
 * `POST /appointments` refuses a past start time, which is correct — so these
 * are booked ahead and then moved backwards directly. The buffer columns move
 * with the window because `appointments_buffer_check` requires
 * `buffer_start_at <= starts_at` and `buffer_end_at >= ends_at`; shifting only
 * the appointment would leave the row failing its own constraint.
 *
 * Statuses are spread the way a real diary spreads them: mostly completed, a
 * few cancelled, the occasional no-show.
 */
async function ageIntoThePast(appointments) {
  let aged = 0;
  for (const [index, appointment] of appointments.entries()) {
    // Measured from *today*, not from the booking. Shifting by a flat 1–45 days
    // works only if the appointment was already close: Lighthouse runs evening
    // classes five days a week, so its bookings spread three weeks out and a
    // one-day shift left them in the future — 8 rows marked COMPLETED with a
    // start time that had not happened yet.
    const daysAhead = Math.max(
      0,
      Math.ceil((new Date(appointment.startsAt).getTime() - Date.now()) / 86_400_000),
    );
    const daysBack = daysAhead + 1 + (index % 45);
    const status = index % 11 === 0 ? 'CANCELLED' : index % 17 === 0 ? 'NO_SHOW' : 'COMPLETED';

    if (!appointment?.id) {
      throw new Error('An appointment came back without an id; refusing to age nothing silently.');
    }

    const result = await db.query(
      `UPDATE appointments
          SET starts_at        = starts_at - make_interval(days => $2),
              ends_at          = ends_at   - make_interval(days => $2),
              buffer_start_at  = buffer_start_at - make_interval(days => $2),
              buffer_end_at    = buffer_end_at   - make_interval(days => $2),
              status           = $3,
              completed_at     = CASE WHEN $3 = 'COMPLETED'
                                      THEN ends_at - make_interval(days => $2) END,
              cancelled_at     = CASE WHEN $3 = 'CANCELLED' THEN now() END,
              cancellation_reason = CASE WHEN $3 = 'CANCELLED'
                                         THEN 'Cancelled by the customer.' END
        WHERE id = $1`,
      [appointment.id, daysBack, status],
    );
    // Counted from what the database actually changed, not from the loop.
    aged += result.rowCount;
  }
  return aged;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const reset = process.argv.includes('--reset');

  await db.connect();

  try {
    await fetch(`${API}/health`);
  } catch {
    console.error(`The API is not answering at ${API}. Start the stack with "npm run dev" first.`);
    process.exit(1);
  }

  if (reset) {
    console.log('\n▸ resetting the database and reseeding Aurora Wellness Studio');
    await db.end();
    execFileSync('npm', ['run', 'db:reset'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, SEED_ENABLED: 'true' },
      shell: process.platform === 'win32',
    });
    db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
  }

  console.log('\n▸ building workspaces');
  const built = [];
  for (const spec of WORKSPACES) {
    try {
      built.push(await buildWorkspace(spec));
    } catch (error) {
      console.error(`    ! ${spec.name} failed: ${error.message}`);
    }
  }

  console.log('\n▸ booking appointments');
  for (const workspace of built) {
    const { past, upcoming } = workspace.spec.appointments;
    const all = await bookUpcoming(workspace, past + upcoming);

    // Aged by *proportion*, not by the raw target. Services share staff, so the
    // exclusion constraint legitimately refuses some slots and a workspace can
    // come back with fewer bookings than asked for — at which point ageing the
    // first `past` of them moves the entire diary into history and leaves the
    // schedule screen empty. Clearwater and Sterling both did exactly that.
    const share = past / (past + upcoming);
    const toAge = Math.min(past, Math.floor(all.length * share));
    const aged = await ageIntoThePast(all.slice(0, toAge));
    process.stdout.write(
      `  ${workspace.spec.name}: ${all.length} booked (${aged} moved into the past)\n`,
    );
  }

  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM businesses)   AS businesses,
            (SELECT count(*) FROM users)        AS users,
            (SELECT count(*) FROM customers)    AS customers,
            (SELECT count(*) FROM appointments) AS appointments`,
  );

  console.log('\n▸ done');
  console.log(`  businesses   ${rows[0].businesses}`);
  console.log(`  users        ${rows[0].users}`);
  console.log(`  customers    ${rows[0].customers}`);
  console.log(`  appointments ${rows[0].appointments}`);
  console.log(`\n  Every account signs in with: ${PASSWORD}\n`);

  const appUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
  console.log('  Owners');
  for (const workspace of built) {
    console.log(`    ${workspace.spec.owner.email.padEnd(44)} ${workspace.spec.name}`);
  }
  console.log(`\n  Public booking pages`);
  for (const workspace of built) {
    for (const link of workspace.spec.links) {
      console.log(`    ${appUrl}/b/${link.slug}`);
    }
  }
  console.log('');

  await db.end();
}

await main();
