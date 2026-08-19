/**
 * That the SSRF guard is actually attached to the endpoint.
 *
 * `ssrf.test.ts` proves the guard decides correctly. This proves the decision
 * is consulted — which is a separate claim, and the one that quietly stops
 * being true. Deleting the `assertDeliverableUrl` call from
 * `webhooks.service.ts` leaves every unit test in `ssrf.test.ts` green and
 * every range still correctly classified, and lets a tenant register
 * `http://169.254.169.254/` again.
 *
 * The whole file runs with the guard forced on. `tests/setup.ts` turns it off
 * for the suite so `webhooks.test.ts` can deliver to a real receiver on
 * 127.0.0.1; here that would make every assertion pass for the wrong reason.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/config/env';

vi.mock('../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, WEBHOOK_ALLOW_PRIVATE_TARGETS: false } };
});

import { createApp } from '../../src/app';
import { WebhookEndpoint } from '../../src/database/models';
import { closeDatabaseConnection, resetDatabase } from '../helpers/fixtures';

const app = createApp();
const password = 'Str0ngPass!2026';

let token: string;
let businessId: string;

beforeAll(async () => {
  await resetDatabase();

  const email = `ssrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@meetflow.test`;
  const registration = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, firstName: 'Test', lastName: 'Owner', timezone: 'Asia/Kolkata' })
    .expect(201);
  token = registration.body.data.accessToken as string;

  const workspace = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'SSRF Clinic', timezone: 'Asia/Kolkata' })
    .expect(201);
  businessId = workspace.body.data.business.id as string;
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function post(url: string) {
  return request(app)
    .post('/api/v1/webhooks')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Business-Id', businessId)
    .send({ url, events: ['appointment.created'] });
}

describe('registering a delivery URL', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:3000/hook'],
    ['localhost by name', 'http://localhost:3000/hook'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['a private range', 'http://10.0.0.5/hook'],
    ['IPv6 loopback', 'http://[::1]:3000/hook'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/hook'],
  ])('refuses %s', async (_label, url) => {
    const response = await post(url).expect(422);
    // Named, so an operator can tell this from a typo in the path.
    expect(response.body.error.message).toMatch(/private or reserved range/i);
  });

  it('creates nothing when it refuses', async () => {
    await post('http://169.254.169.254/').expect(422);
    // A 422 that still wrote the row would leave the endpoint disabled-looking
    // in the list and deliverable by anything that reads it directly.
    expect(await WebhookEndpoint.count({ where: { businessId } })).toBe(0);
  });

  it('still accepts a public URL', async () => {
    // The guard has to let real endpoints through, or it is just an outage.
    const response = await post('https://hooks.example.com/meetflow').expect(201);
    expect(response.body.data.url).toBe('https://hooks.example.com/meetflow');
  });

  it('refuses an edit that moves a public endpoint to a private address', async () => {
    const created = await post('https://hooks.example.com/second').expect(201);

    // The check that only exists because create-time validation alone is a
    // check somebody walks around by registering first and editing after.
    const response = await request(app)
      .patch(`/api/v1/webhooks/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', businessId)
      .send({ url: 'http://127.0.0.1:9000/hook' })
      .expect(422);
    expect(response.body.error.message).toMatch(/private or reserved range/i);

    const row = await WebhookEndpoint.findByPk(created.body.data.id);
    expect(row!.url).toBe('https://hooks.example.com/second');
  });
});
