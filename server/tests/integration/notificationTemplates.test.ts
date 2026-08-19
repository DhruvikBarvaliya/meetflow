/**
 * `/api/v1/notification-templates`, over real HTTP.
 *
 * The endpoint exists to close a gap that was invisible from the outside:
 * `resolveTemplate` had always preferred a workspace row over the built-in
 * default, nothing ever wrote such a row, and `templates:manage` was granted to
 * every owner while guarding no endpoint at all. So the tests that matter here
 * are not the CRUD ones. They are:
 *
 *  - that an override actually reaches a customer — asserted by enqueuing a real
 *    notification afterwards and reading the copy off the outbox row, not by
 *    reading back what was just written;
 *  - that a placeholder the message cannot fill is refused, because the failure
 *    it prevents is silent: `renderTemplate` substitutes an unknown name with an
 *    empty string, so a typo ships an email opening "Hi ," with nothing logged;
 *  - that resetting restores the *living* default rather than a copy, which is
 *    the reason defaults are not seeded into workspaces;
 *  - that one workspace's copy is invisible and unreachable from another's.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import {
  Customer,
  Membership,
  Notification,
  NotificationTemplate,
  Role,
} from '../../src/database/models';
import {
  buildHtmlBody,
  enqueueNotification,
} from '../../src/modules/notifications/notification.service';
import { DEFAULT_TEMPLATES } from '../../src/modules/notifications/templates';
import { closeDatabaseConnection, resetDatabase } from '../helpers/fixtures';

const app = createApp();
const password = 'Str0ngPass!2026';

interface Session {
  token: string;
  email: string;
  businessId: string;
}

async function registerWorkspace(tag: string, name: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@meetflow.test`;

  const registration = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, firstName: 'Test', lastName: 'Owner', timezone: 'Asia/Kolkata' })
    .expect(201);
  const token = registration.body.data.accessToken as string;

  const workspace = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, timezone: 'Asia/Kolkata' })
    .expect(201);

  return { token, email, businessId: workspace.body.data.business.id as string };
}

function as(session: Session) {
  return (req: request.Test) =>
    req.set('Authorization', `Bearer ${session.token}`).set('X-Business-Id', session.businessId);
}

const CONFIRMATION_DEFAULT = DEFAULT_TEMPLATES.find(
  (item) => item.key === 'BOOKING_CONFIRMATION' && item.channel === 'EMAIL',
)!;

let owner: Session;
let rival: Session;
let recipient: Customer;

beforeAll(async () => {
  await resetDatabase();
  owner = await registerWorkspace('templates-owner', 'Riverside Clinic');
  rival = await registerWorkspace('templates-rival', 'Rival Clinic');

  // A real customer row, because `notifications_recipient_check` requires the
  // id that matches the recipient type — an outbox row addressed to "a
  // customer" with no customer is refused by the table itself.
  recipient = await Customer.create({
    businessId: owner.businessId,
    publicId: `cus_${Date.now()}`,
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'customer@meetflow.test',
  });
});

beforeEach(async () => {
  await NotificationTemplate.destroy({ where: {}, force: true });
  await Notification.destroy({ where: {}, force: true });
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('listing', () => {
  it('shows every message MeetFlow sends, not only the ones overridden', async () => {
    // The table is empty for a workspace that has never edited anything. A
    // listing driven off it would be blank on exactly the visit where an
    // operator most needs to see what is being sent in their name.
    const response = await as(owner)(request(app).get('/api/v1/notification-templates')).expect(
      200,
    );

    const rows = response.body.data as Array<{ key: string; source: string; bodyText: string }>;
    expect(rows.length).toBe(DEFAULT_TEMPLATES.length);
    expect(rows.every((row) => row.source === 'BUILT_IN')).toBe(true);

    const confirmation = rows.find((row) => row.key === 'BOOKING_CONFIRMATION');
    expect(confirmation?.bodyText).toBe(CONFIRMATION_DEFAULT.bodyText);
  });

  it('names the placeholders each message can fill', async () => {
    const response = await as(owner)(
      request(app).get('/api/v1/notification-templates/BOOKING_RESCHEDULED/EMAIL'),
    ).expect(200);

    const names = (response.body.data.placeholders as Array<{ name: string }>).map(
      (item) => item.name,
    );
    // `previousStartsAtLocal` exists only on a reschedule, and is the clearest
    // evidence the catalogue is per-key rather than one shared list.
    expect(names).toContain('previousStartsAtLocal');
    expect(names).toContain('customerName');

    const confirmation = await as(owner)(
      request(app).get('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL'),
    ).expect(200);
    expect(
      (confirmation.body.data.placeholders as Array<{ name: string }>).map((item) => item.name),
    ).not.toContain('previousStartsAtLocal');
  });
});

describe('overriding', () => {
  it('reaches the customer, not just the read-back', async () => {
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'You are booked in at {{businessName}}',
        bodyText: 'Hi {{customerName}}, see you at {{startsAtLocal}}.',
      }),
    ).expect(200);

    // The real proof: enqueue a notification the way a booking would and read
    // the copy off the outbox row. Asserting the PUT's own response would only
    // prove the endpoint echoes its input.
    await enqueueNotification({
      businessId: owner.businessId,
      type: 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: recipient.id,
      recipientAddress: recipient.email,
      payload: {
        customerName: 'Priya Shah',
        businessName: 'Riverside Clinic',
        startsAtLocal: 'Tuesday at 10:00 am',
      },
    });

    const row = await Notification.findOne({ where: { businessId: owner.businessId } });
    expect(row?.subject).toBe('You are booked in at Riverside Clinic');
    expect(row?.body).toContain('Hi Priya Shah, see you at Tuesday at 10:00 am.');
    expect(row?.body).not.toContain(CONFIRMATION_DEFAULT.bodyText);
  });

  it('refuses a placeholder the message cannot fill, and says which', async () => {
    const response = await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Confirmed',
        // A typo, and the exact failure the endpoint exists to prevent: this
        // would render as "Hi ," for every customer, with nothing logged.
        bodyText: 'Hi {{cusotmerName}}, see you then.',
      }),
    ).expect(422);

    expect(response.body.error.message).toContain('{{cusotmerName}}');
    // And it lists what is available, so the fix is one glance away.
    expect(response.body.error.message).toContain('{{customerName}}');
    expect(await NotificationTemplate.count()).toBe(0);
  });

  it('refuses a placeholder that belongs to a different message', async () => {
    // `previousStartsAtLocal` is real — just not on this one. A catalogue that
    // was one shared list would let this through and render it empty.
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Confirmed',
        bodyText: 'Moved from {{previousStartsAtLocal}}.',
      }),
    ).expect(422);
  });

  it('refuses an email with no subject line', async () => {
    // Every spam filter reads a blank subject exactly as it looks.
    await as(owner)(
      request(app)
        .put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL')
        .send({ bodyText: 'Hi {{customerName}}.' }),
    ).expect(422);
  });

  it('never stores tenant-authored HTML', async () => {
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Confirmed',
        bodyText: '<script>alert(1)</script> Hi {{customerName}}.',
      }),
    ).expect(200);

    const stored = await NotificationTemplate.findOne({ where: { businessId: owner.businessId } });
    // The column the mail body is generated from is text, and the HTML part is
    // generated by `textToHtml`, which escapes. Nothing tenant-authored reaches
    // an email as markup.
    expect(stored?.bodyHtml).toBeNull();

    await enqueueNotification({
      businessId: owner.businessId,
      type: 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: recipient.id,
      recipientAddress: recipient.email,
      payload: { customerName: 'Priya Shah' },
    });
    const row = await Notification.findOne({ where: { businessId: owner.businessId } });

    // `body` is the plain-text part and holds the angle brackets literally,
    // which is correct — text is text. What matters is the HTML part the
    // provider is handed, which is generated rather than stored, so this
    // asserts the generated form.
    const html = buildHtmlBody(row!.body!, row!.payload);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('replaces rather than duplicating when saved twice', async () => {
    const put = (bodyText: string) =>
      as(owner)(
        request(app)
          .put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL')
          .send({ subject: 'Confirmed', bodyText }),
      ).expect(200);

    await put('First draft for {{customerName}}.');
    await put('Second draft for {{customerName}}.');

    // The partial unique index is on (business_id, key, channel, locale) and is
    // the reason `Model.upsert` cannot be used here — PostgreSQL will not infer
    // a partial index from a bare column list.
    const rows = await NotificationTemplate.findAll({ where: { businessId: owner.businessId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyText).toBe('Second draft for {{customerName}}.');
  });

  it('parks a draft without sending it when switched off', async () => {
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Draft subject',
        bodyText: 'Draft for {{customerName}}.',
        isActive: false,
      }),
    ).expect(200);

    const view = await as(owner)(
      request(app).get('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL'),
    ).expect(200);
    // The row is theirs, but the default is what customers receive.
    expect(view.body.data.source).toBe('BUILT_IN');
    expect(view.body.data.bodyText).toBe(CONFIRMATION_DEFAULT.bodyText);

    await enqueueNotification({
      businessId: owner.businessId,
      type: 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: recipient.id,
      recipientAddress: recipient.email,
      payload: { customerName: 'Priya Shah' },
    });
    const row = await Notification.findOne({ where: { businessId: owner.businessId } });
    // The stored subject is the *rendered* default, so it is compared against
    // the default with the same substitution applied rather than against the
    // raw template.
    expect(row?.subject).toBe(CONFIRMATION_DEFAULT.subject.replace('{{serviceName}}', ''));
    expect(row?.subject).not.toContain('Draft subject');
  });
});

describe('resetting', () => {
  it('restores the living default rather than a stored copy', async () => {
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Ours',
        bodyText: 'Ours, for {{customerName}}.',
      }),
    ).expect(200);

    await as(owner)(
      request(app).delete('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL'),
    ).expect(204);

    // The row is gone entirely — not deactivated, not replaced with a snapshot
    // — so the next send reads DEFAULT_TEMPLATES and picks up every later
    // improvement to it.
    expect(await NotificationTemplate.count({ where: { businessId: owner.businessId } })).toBe(0);

    await enqueueNotification({
      businessId: owner.businessId,
      type: 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: recipient.id,
      recipientAddress: recipient.email,
      payload: { customerName: 'Priya Shah', serviceName: 'Physiotherapy' },
    });
    const row = await Notification.findOne({ where: { businessId: owner.businessId } });
    expect(row?.subject).toBe(
      CONFIRMATION_DEFAULT.subject.replace('{{serviceName}}', 'Physiotherapy'),
    );
    expect(row?.subject).not.toContain('Ours');
    expect(row?.body).toContain('Priya Shah');
  });

  it('answers 404 when there is nothing to reset', async () => {
    // 204 here would tell an operator their edit was undone when there was no
    // edit.
    await as(owner)(
      request(app).delete('/api/v1/notification-templates/BOOKING_CANCELLED/EMAIL'),
    ).expect(404);
  });
});

describe('previewing', () => {
  it('renders a draft against believable sample data before it is saved', async () => {
    const response = await as(owner)(
      request(app).post('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL/preview').send({
        subject: 'Booked at {{businessName}}',
        bodyText: 'Hi {{customerName}}, {{serviceName}} at {{startsAtLocal}}.',
      }),
    ).expect(200);

    expect(response.body.data.subject).not.toContain('{{');
    expect(response.body.data.bodyText).not.toContain('{{');
    expect(response.body.data.bodyText).toContain('Priya Shah');
    expect(response.body.data.bodyHtml).toContain('<p');
    // Previewing writes nothing: the operator is still deciding.
    expect(await NotificationTemplate.count()).toBe(0);
  });

  it('refuses to preview what it would refuse to save', async () => {
    // Otherwise the preview becomes the place a bad template looks fine.
    await as(owner)(
      request(app)
        .post('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL/preview')
        .send({ bodyText: 'Hi {{cusotmerName}}.' }),
    ).expect(422);
  });
});

describe('authority and isolation', () => {
  it('refuses a member whose role lacks templates:manage', async () => {
    // The permission was granted to every owner and attached to no endpoint.
    // This is the assertion that it now guards something — and it is done by
    // demoting the real membership rather than by asserting the owner succeeds,
    // because "the owner can" is true of every endpoint and proves nothing.
    const membership = await Membership.findOne({ where: { businessId: owner.businessId } });
    const staffRole = await Role.findOne({ where: { businessId: owner.businessId, key: 'STAFF' } });
    const originalRoleId = membership!.roleId;

    await membership!.update({ roleId: staffRole!.id });
    try {
      await as(owner)(request(app).get('/api/v1/notification-templates')).expect(403);
      await as(owner)(
        request(app)
          .put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL')
          .send({ subject: 'Nope', bodyText: 'Hi {{customerName}}.' }),
      ).expect(403);
    } finally {
      await membership!.update({ roleId: originalRoleId });
    }

    // 403 and not a silent no-op: nothing was written.
    expect(await NotificationTemplate.count({ where: { businessId: owner.businessId } })).toBe(0);
  });

  it('refuses a stranger with 404 rather than 403', async () => {
    // A caller who is not a member learns nothing about whether the workspace
    // exists — the same rule every other tenant-scoped route follows.
    await request(app)
      .get('/api/v1/notification-templates')
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', owner.businessId)
      .expect(404);
  });

  it('keeps one workspace’s copy invisible to another', async () => {
    await as(owner)(
      request(app).put('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL').send({
        subject: 'Riverside only',
        bodyText: 'Private copy for {{customerName}}.',
      }),
    ).expect(200);

    const seen = await as(rival)(
      request(app).get('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL'),
    ).expect(200);

    expect(seen.body.data.source).toBe('BUILT_IN');
    expect(seen.body.data.bodyText).toBe(CONFIRMATION_DEFAULT.bodyText);

    // And the rival cannot reset what it cannot see — the delete is scoped to
    // its own tenant, so it finds no row rather than deleting somebody else's.
    await as(rival)(
      request(app).delete('/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL'),
    ).expect(404);
    expect(await NotificationTemplate.count({ where: { businessId: owner.businessId } })).toBe(1);
  });

  it('rejects a key or channel it does not define', async () => {
    await as(owner)(request(app).get('/api/v1/notification-templates/NOT_A_TEMPLATE/EMAIL')).expect(
      422,
    );
    await as(owner)(
      request(app).get('/api/v1/notification-templates/BOOKING_CONFIRMATION/CARRIER_PIGEON'),
    ).expect(422);
  });
});
