/**
 * The workspace audit trail, read over real HTTP.
 *
 * Every mutating service in MeetFlow writes to `audit_logs`, and until this
 * surface existed nothing could read one back. What has to be proven here is
 * therefore not "the query works" but "the query cannot be made to answer about
 * anybody else", and that is a claim about a boundary rather than about a
 * function — which means it can only be tested end to end, through
 * `requireTenant`, the permission guard and the real SQL.
 *
 * Three properties carry the file:
 *
 *  1. **Only the caller's workspace.** Two workspaces act in parallel; the
 *     assertion is that the second one's entry ids never appear in the first
 *     one's feed, its ids 404 rather than 403, and a distinctive string it wrote
 *     is absent from the serialised response.
 *  2. **Never a platform-level row.** `business_id IS NULL` marks events about
 *     the deployment, not about a tenant. The marker planted below is
 *     deliberately *about* the workspace under test — same `entity_id` — so the
 *     test fails if the exclusion is ever weakened to "rows mentioning me".
 *  3. **`audit:read`, and nothing weaker.** An owner and a manager hold it; a
 *     receptionist does not, and is refused.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { AuditLog, Membership, Role } from '../../src/database/models';
import { auditRouter } from '../../src/modules/audit/audit.routes';
import { AuditActions, recordAudit } from '../../src/modules/audit/audit.service';
import { managementRouter } from '../../src/routes';
import { todayInZone } from '../../src/utils/time';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

/**
 * The router under test, mounted onto the real management chain.
 *
 * routes/index.ts is owned by the wiring that assembles the API surface, and
 * this file has to pass whether or not that mount has landed yet. Mounting here
 * puts `auditRouter` behind the same
 * `authenticate -> apiRateLimit -> requireTenant` chain the shipped app uses, so
 * every assertion below is made against the genuine stack rather than a
 * hand-built one. Should routes/index.ts also mount it, that mount is declared
 * first and answers first; this one is then never reached and is inert.
 */
managementRouter.use('/audit-logs', auditRouter);

const app = createApp();

const TIMEZONE = 'Asia/Kolkata';

/** Written by the rival workspace, and searched for in Aurora's responses. */
const RIVAL_LOCATION = 'Borealis-Only-Reading-Room';

/** Planted on a platform-level row that names Aurora's own business id. */
const PLATFORM_MARKER = 'platform-only-never-in-a-tenant-feed';

interface Account {
  userId: string;
  email: string;
  token: string;
}

interface Workspace {
  businessId: string;
  owner: Account;
}

let aurora: Workspace;
let borealis: Workspace;
let manager: Account;
let receptionist: Account;
/** Two locations in Aurora, so the entity filters have something to select. */
let clinicLocationId: string;
let annexeLocationId: string;

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function registerAccount(tag: string, firstName: string): Promise<Account> {
  const email = `${tag}-${process.pid}-${Date.now()}@meetflow.test`;
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: TEST_PASSWORD, firstName, lastName: 'Owner', timezone: TIMEZONE })
    .expect(201);

  return {
    userId: response.body.data.user.id as string,
    email,
    token: response.body.data.accessToken as string,
  };
}

async function createWorkspaceFor(owner: Account, name: string): Promise<Workspace> {
  const response = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', bearer(owner.token))
    .send({ name, timezone: TIMEZONE })
    .expect(201);

  return { businessId: response.body.data.business.id as string, owner };
}

/**
 * A colleague holding one of the built-in roles.
 *
 * The membership is written directly rather than invited through the API: this
 * file is about what the audit surface returns, and an invitation flow would add
 * its own entries to the very feed under assertion.
 */
async function addMember(
  businessId: string,
  roleKey: 'MANAGER' | 'RECEPTIONIST',
  firstName: string,
): Promise<Account> {
  const user = await createUser({ firstName });
  const role = await Role.findOne({ where: { businessId, key: roleKey } });
  if (!role) throw new Error(`fixture expected a ${roleKey} role`);

  await Membership.create({
    userId: user.id,
    businessId,
    roleId: role.id,
    status: 'ACTIVE',
    invitedByUserId: null,
    invitedAt: null,
    joinedAt: new Date(),
  });

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD })
    .expect(200);

  return { userId: user.id, email: user.email, token: login.body.data.accessToken as string };
}

async function createLocation(workspace: Workspace, name: string): Promise<string> {
  const response = await request(app)
    .post('/api/v1/locations')
    .set('Authorization', bearer(workspace.owner.token))
    .set('X-Business-Id', workspace.businessId)
    .send({ name, type: 'PHYSICAL', timezone: TIMEZONE })
    .expect(201);

  return response.body.data.id as string;
}

interface FeedRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorLabel: string | null;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/** One page of Aurora's feed, as the owner, with the given filters applied. */
async function readFeed(
  token: string,
  businessId: string,
  filters: Record<string, string | number> = {},
): Promise<{ rows: FeedRow[]; totalItems: number; body: unknown }> {
  const response = await request(app)
    .get('/api/v1/audit-logs')
    .query({ pageSize: 100, ...filters })
    .set('Authorization', bearer(token))
    .set('X-Business-Id', businessId)
    .expect(200);

  return {
    rows: response.body.data as FeedRow[],
    totalItems: response.body.meta.totalItems as number,
    body: response.body,
  };
}

beforeAll(async () => {
  await resetDatabase();

  const auroraOwner = await registerAccount('aurora-owner', 'Nadia');
  const borealisOwner = await registerAccount('borealis-owner', 'Tomas');
  aurora = await createWorkspaceFor(auroraOwner, 'Aurora Clinic Bandra');
  borealis = await createWorkspaceFor(borealisOwner, 'Borealis Wellness Rooms');

  manager = await addMember(aurora.businessId, 'MANAGER', 'Meera');
  receptionist = await addMember(aurora.businessId, 'RECEPTIONIST', 'Rhys');

  // Act in both workspaces, so isolation is a claim about two live feeds rather
  // than about one feed and an empty table.
  clinicLocationId = await createLocation(aurora, 'Bandra Clinic');
  annexeLocationId = await createLocation(aurora, 'Bandra Annexe');
  await createLocation(borealis, RIVAL_LOCATION);

  await request(app)
    .patch('/api/v1/workspace')
    .set('Authorization', bearer(aurora.owner.token))
    .set('X-Business-Id', aurora.businessId)
    .send({ name: 'Aurora Clinic Bandra West' })
    .expect(200);

  /*
   * A platform-level entry that names Aurora's business id as its subject.
   * Registration and sign-in already write rows like this; planting one
   * explicitly means the assertion can be exact, and pointing it at Aurora means
   * a "rows that mention me" implementation would fail rather than pass.
   */
  await recordAudit({
    businessId: null,
    actorType: 'SYSTEM',
    actorLabel: PLATFORM_MARKER,
    action: AuditActions.PLATFORM_WORKSPACE_STATUS_CHANGED,
    entityType: 'business',
    entityId: aurora.businessId,
    metadata: { note: PLATFORM_MARKER },
  });
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('reading the workspace trail', () => {
  it('returns the entries the workspace produced, newest first', async () => {
    const { rows, totalItems } = await readFeed(aurora.owner.token, aurora.businessId);

    expect(totalItems).toBeGreaterThan(0);
    expect(rows.length).toBe(totalItems);

    const actions = rows.map((row) => row.action);
    expect(actions).toContain(AuditActions.BUSINESS_CREATED);
    expect(actions).toContain(AuditActions.LOCATION_CREATED);
    expect(actions).toContain(AuditActions.BUSINESS_UPDATED);

    const timestamps = rows.map((row) => Date.parse(row.createdAt));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('reports the zone its date filters are cut in', async () => {
    const response = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    expect(response.body.meta.timezone).toBe(TIMEZONE);
  });

  it('surfaces the actor snapshot rather than a join', async () => {
    const { rows } = await readFeed(aurora.owner.token, aurora.businessId, {
      action: AuditActions.LOCATION_CREATED,
    });

    // `actorLabel` is the denormalised value written at the time, which is what
    // keeps the trail readable after the account behind it is deleted.
    for (const row of rows) {
      expect(row.actorLabel).toBe(aurora.owner.email);
      expect(row.actorUserId).toBe(aurora.owner.userId);
      expect(row.actorType).toBe('USER');
    }
  });

  it('returns metadata, which was redacted on the way in', async () => {
    const { rows } = await readFeed(aurora.owner.token, aurora.businessId, {
      action: AuditActions.LOCATION_CREATED,
      entityId: clinicLocationId,
    });

    expect(rows[0]?.metadata).toMatchObject({ name: 'Bandra Clinic', type: 'PHYSICAL' });
  });

  it('returns one entry in full, including its user agent', async () => {
    const { rows } = await readFeed(aurora.owner.token, aurora.businessId, {
      entityId: annexeLocationId,
    });
    const entryId = rows[0]!.id;

    const response = await request(app)
      .get(`/api/v1/audit-logs/${entryId}`)
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    expect(response.body.data.id).toBe(entryId);
    expect(response.body.data.entityId).toBe(annexeLocationId);
    // Present on the single entry and absent from the list, by design.
    expect(response.body.data).toHaveProperty('userAgent');
    expect(rows[0]).not.toHaveProperty('userAgent');
  });

  it('rejects a workspace id in the query string', async () => {
    // `.strict()`: the tenant comes from the membership, so this can only ever
    // be an attempt to read somebody else's trail.
    await request(app)
      .get('/api/v1/audit-logs')
      .query({ businessId: borealis.businessId })
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(422);
  });
});

describe('who may read it', () => {
  it('lets a manager read the trail', async () => {
    const { totalItems } = await readFeed(manager.token, aurora.businessId);
    expect(totalItems).toBeGreaterThan(0);
  });

  it('refuses a receptionist, who holds no audit:read', async () => {
    await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', bearer(receptionist.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(403);
  });

  it('refuses a receptionist the single-entry route too', async () => {
    const { rows } = await readFeed(aurora.owner.token, aurora.businessId);

    await request(app)
      .get(`/api/v1/audit-logs/${rows[0]!.id}`)
      .set('Authorization', bearer(receptionist.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(403);
  });
});

describe('filters', () => {
  it('narrows by action', async () => {
    const { rows, totalItems } = await readFeed(aurora.owner.token, aurora.businessId, {
      action: AuditActions.LOCATION_CREATED,
    });

    expect(totalItems).toBe(2);
    expect(rows.every((row) => row.action === AuditActions.LOCATION_CREATED)).toBe(true);
  });

  it('narrows by entity type', async () => {
    const { rows, totalItems } = await readFeed(aurora.owner.token, aurora.businessId, {
      entityType: 'location',
    });

    expect(totalItems).toBe(2);
    expect(rows.every((row) => row.entityType === 'location')).toBe(true);
  });

  it('narrows by entity id', async () => {
    const { rows, totalItems } = await readFeed(aurora.owner.token, aurora.businessId, {
      entityId: clinicLocationId,
    });

    expect(totalItems).toBe(1);
    expect(rows[0]?.entityId).toBe(clinicLocationId);
  });

  it('narrows by actor', async () => {
    const asOwner = await readFeed(aurora.owner.token, aurora.businessId, {
      actorUserId: aurora.owner.userId,
    });
    expect(asOwner.totalItems).toBeGreaterThan(0);
    expect(asOwner.rows.every((row) => row.actorUserId === aurora.owner.userId)).toBe(true);

    // The manager has read the feed but changed nothing, so they have written no
    // entries at all.
    const asManager = await readFeed(aurora.owner.token, aurora.businessId, {
      actorUserId: manager.userId,
    });
    expect(asManager.totalItems).toBe(0);
  });

  it('treats from/to as whole inclusive days on the workspace clock', async () => {
    const today = todayInZone(TIMEZONE);
    const all = await readFeed(aurora.owner.token, aurora.businessId);

    const sameDay = await readFeed(aurora.owner.token, aurora.businessId, {
      from: today,
      to: today,
    });
    // Everything above happened seconds ago, so a single-day range must return
    // it rather than only the day's first instant.
    expect(sameDay.totalItems).toBe(all.totalItems);

    const longAgo = await readFeed(aurora.owner.token, aurora.businessId, {
      from: '2020-01-01',
      to: '2020-01-02',
    });
    expect(longAgo.totalItems).toBe(0);
  });

  it('rejects a range that ends before it starts', async () => {
    await request(app)
      .get('/api/v1/audit-logs')
      .query({ from: '2026-03-02', to: '2026-03-01' })
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(422);
  });

  it('searches the actor snapshot, the verb and the entity type', async () => {
    const byActor = await readFeed(aurora.owner.token, aurora.businessId, {
      search: aurora.owner.email,
    });
    expect(byActor.totalItems).toBeGreaterThan(0);

    const byVerb = await readFeed(aurora.owner.token, aurora.businessId, { search: 'location.' });
    expect(byVerb.totalItems).toBe(2);
  });

  it('treats a LIKE wildcard as a literal character', async () => {
    // Unescaped, this pattern would match every entry in the workspace.
    const { totalItems } = await readFeed(aurora.owner.token, aurora.businessId, { search: '%' });
    expect(totalItems).toBe(0);
  });
});

describe('tenant isolation', () => {
  it("never returns another workspace's entries", async () => {
    const rivalRows = await AuditLog.findAll({
      where: { businessId: borealis.businessId },
      attributes: ['id'],
    });
    expect(rivalRows.length).toBeGreaterThan(0);

    const { rows, body } = await readFeed(aurora.owner.token, aurora.businessId);
    const visible = new Set(rows.map((row) => row.id));

    for (const rival of rivalRows) {
      expect(visible.has(rival.id)).toBe(false);
    }

    // The shape assertion above would still pass if the rival's rows arrived
    // under different ids, so the serialised response is searched for something
    // only Borealis ever wrote.
    expect(JSON.stringify(body)).not.toContain(RIVAL_LOCATION);
  });

  it('shows each workspace only its own totals', async () => {
    const auroraFeed = await readFeed(aurora.owner.token, aurora.businessId);
    const borealisFeed = await readFeed(borealis.owner.token, borealis.businessId);

    const auroraIds = new Set(auroraFeed.rows.map((row) => row.id));
    expect(borealisFeed.rows.some((row) => auroraIds.has(row.id))).toBe(false);
    expect(borealisFeed.totalItems).toBeGreaterThan(0);
  });

  it('never returns a platform-level entry', async () => {
    const platformRows = await AuditLog.findAll({ where: { businessId: null } });
    // Sign-ins and registrations write these, and the marker planted in the
    // fixtures is among them; if this is empty the test below proves nothing.
    expect(platformRows.length).toBeGreaterThan(0);

    const { rows, body } = await readFeed(aurora.owner.token, aurora.businessId);
    const visible = new Set(rows.map((row) => row.id));

    for (const platformRow of platformRows) {
      expect(visible.has(platformRow.id)).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain(PLATFORM_MARKER);
  });

  it("404s — not 403s — on another workspace's entry id", async () => {
    const rival = await AuditLog.findOne({ where: { businessId: borealis.businessId } });
    expect(rival).not.toBeNull();

    // A 403 would confirm the entry exists, turning the endpoint into an
    // existence oracle for other tenants' audit trails.
    await request(app)
      .get(`/api/v1/audit-logs/${rival!.id}`)
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(404);

    // The same id, read by the workspace it belongs to, proves it is real.
    await request(app)
      .get(`/api/v1/audit-logs/${rival!.id}`)
      .set('Authorization', bearer(borealis.owner.token))
      .set('X-Business-Id', borealis.businessId)
      .expect(200);
  });

  it('404s on a platform-level entry id', async () => {
    const platformRow = await AuditLog.findOne({ where: { businessId: null } });
    expect(platformRow).not.toBeNull();

    await request(app)
      .get(`/api/v1/audit-logs/${platformRow!.id}`)
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(404);
  });
});

/**
 * Declared last: the export writes a `report.exported` entry of its own, which
 * changes the totals the suites above assert exactly. Vitest runs suites in
 * declaration order within a file, which is what makes that safe.
 */
describe('CSV export', () => {
  it('exports the caller’s own trail and nobody else’s', async () => {
    const response = await request(app)
      .get('/api/v1/audit-logs/export.csv')
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .buffer(true)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('.csv');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Number(response.headers['x-report-matched-rows'])).toBeGreaterThan(0);
    expect(response.headers['x-report-truncated']).toBe('false');

    expect(response.text).toContain('Recorded at (UTC)');
    expect(response.text).toContain(AuditActions.LOCATION_CREATED);
    expect(response.text).toContain(aurora.owner.email);
    expect(response.text).not.toContain(RIVAL_LOCATION);
    expect(response.text).not.toContain(PLATFORM_MARKER);
  });

  it('records the export in the trail it exported', async () => {
    const exported = await AuditLog.findOne({
      where: { businessId: aurora.businessId, action: AuditActions.REPORT_EXPORTED },
    });

    expect(exported).not.toBeNull();
    expect(exported!.metadata).toMatchObject({ report: 'audit-logs', format: 'csv' });
  });

  it('refuses a receptionist, who may neither read nor export', async () => {
    await request(app)
      .get('/api/v1/audit-logs/export.csv')
      .set('Authorization', bearer(receptionist.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(403);
  });
});
