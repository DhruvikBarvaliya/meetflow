/**
 * Invalidation of the cached public booking page.
 *
 * Delete these and `cache:link:{slug}` goes back to expiring only by TTL: an
 * operator renames a service or corrects a price, reloads the page every
 * customer sees, and is shown the old one for as long as
 * `CACHE_BOOKING_LINK_TTL_SECONDS` says — with no error anywhere to explain it.
 * The three properties asserted here are the ones the invalidation is only
 * worth having if it keeps: it names the right keys, it does not run until the
 * change is committed, and it cannot turn a Redis problem into a refused edit.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Service } from '../../src/database/models';
import type * as RedisModule from '../../src/config/redis';
import { RedisKeys, cacheDelete } from '../../src/config/redis';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  createBookingLink,
  deleteBookingLink,
  updateBookingLink,
} from '../../src/modules/bookingLinks/bookingLinks.service';
import {
  createBookingLinkSchema,
  updateBookingLinkSchema,
} from '../../src/modules/bookingLinks/bookingLinks.validation';
import { updateBusiness, updateSettings } from '../../src/modules/businesses/business.service';
import { createLocation, deleteLocation } from '../../src/modules/locations/locations.service';
import { createLocationSchema } from '../../src/modules/locations/locations.validation';
import { deleteService, updateService } from '../../src/modules/services/services.service';
import { updateServiceSchema } from '../../src/modules/services/services.validation';
import { updateStaffProfile } from '../../src/modules/staff/staff.service';
import { updateStaffSchema } from '../../src/modules/staff/staff.validation';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

// Only `cacheDelete` is replaced. Everything else in the module — the client,
// the locks the booking path takes — stays real, because this file is about
// which keys the write paths ask to drop, not about Redis being reachable from
// a test runner. A test that needed a live Redis would pass vacuously without
// one, which is the one thing a cache-invalidation test must never do.
vi.mock('../../src/config/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisModule>();
  return { ...actual, cacheDelete: vi.fn(async () => undefined) };
});

const dropped = vi.mocked(cacheDelete);

let fixture: WorkspaceFixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  dropped.mockClear();
  dropped.mockImplementation(async () => undefined);
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function actor(): { userId: string; email: string } {
  return { userId: fixture.user.id, email: fixture.user.email };
}

const metadata = { requestId: 'cache-test', ipAddress: null, userAgent: null };

async function publishLink(name: string): Promise<{ id: string; slug: string }> {
  const link = await createBookingLink(
    fixture.business.id,
    createBookingLinkSchema.parse({ name, type: 'CATALOG' }),
    actor(),
    metadata,
  );
  dropped.mockClear();
  return { id: link.id, slug: link.slug };
}

/** Every key handed to `cacheDelete` across all of this test's calls. */
function droppedKeys(): string[] {
  return dropped.mock.calls.flat();
}

describe('service mutations', () => {
  it('drops every page the workspace publishes', async () => {
    const first = await publishLink('Main page');
    const second = await publishLink('Campaign page');

    await updateService(
      fixture.business.id,
      fixture.service.id,
      updateServiceSchema.parse({ name: 'Extended consultation', priceAmount: 9000 }),
      actor(),
      metadata,
    );

    // Both, not just one: a service appears on every link that offers it, and
    // an uncurated CATALOG link offers the whole public catalogue.
    expect(droppedKeys()).toEqual(
      expect.arrayContaining([
        RedisKeys.bookingLinkConfig(first.slug),
        RedisKeys.bookingLinkConfig(second.slug),
      ]),
    );
  });

  it('waits until the new price is committed before dropping anything', async () => {
    const link = await publishLink('Main page');
    let nameWhenDropped: string | null = null;

    // Read on a connection outside the transaction. Invalidating from inside
    // it would see — and let a concurrent reader re-cache — the old row, which
    // pins the stale page for a full TTL instead of clearing it.
    dropped.mockImplementation(async () => {
      const row = await Service.findByPk(fixture.service.id);
      nameWhenDropped = row?.name ?? null;
    });

    await updateService(
      fixture.business.id,
      fixture.service.id,
      updateServiceSchema.parse({ name: 'Extended consultation' }),
      actor(),
      metadata,
    );

    expect(nameWhenDropped).toBe('Extended consultation');
    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops nothing when the write is refused', async () => {
    await publishLink('Main page');
    await createBooking({
      businessId: fixture.business.id,
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      startsAt: nextWeekdayAt(10),
      timezone: 'UTC',
      customer: { firstName: 'Ada', lastName: 'Customer', email: 'cache@meetflow.test' },
      source: 'PUBLIC',
      actor: { type: 'CUSTOMER', label: 'cache@meetflow.test' },
    });
    dropped.mockClear();

    // Refused: the service still has an appointment in the diary. The page is
    // unchanged, so evicting it would be pure cost.
    await expect(
      deleteService(fixture.business.id, fixture.service.id, actor(), metadata),
    ).rejects.toThrow();

    expect(dropped).not.toHaveBeenCalled();
  });

  it('cannot turn a Redis failure into a refused edit', async () => {
    await publishLink('Main page');
    dropped.mockImplementation(async () => {
      throw new Error('redis is on fire');
    });

    await expect(
      updateService(
        fixture.business.id,
        fixture.service.id,
        updateServiceSchema.parse({ name: 'Still saved' }),
        actor(),
        metadata,
      ),
    ).resolves.toBeDefined();

    // The edit is durable whatever Redis did; the stale entry expires on its
    // own, which is the cheaper of the two failures by a wide margin.
    const row = await Service.findByPk(fixture.service.id);
    expect(row!.name).toBe('Still saved');
  });
});

describe('booking link mutations', () => {
  it('drops the page when the link itself is renamed', async () => {
    const link = await publishLink('Main page');

    await updateBookingLink(
      fixture.business.id,
      link.id,
      updateBookingLinkSchema.parse({ name: 'Winter clinic' }),
      actor(),
      metadata,
    );

    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops the page of a link that was just retired', async () => {
    const link = await publishLink('Main page');

    await deleteBookingLink(fixture.business.id, link.id, actor(), metadata);

    // The lookup behind this runs with `paranoid: false` on purpose — a
    // soft-deleted link is exactly the one whose page must stop being served.
    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops the page a new link inherits at a recycled address', async () => {
    const link = await publishLink('Main page');
    await deleteBookingLink(fixture.business.id, link.id, actor(), metadata);
    dropped.mockClear();

    // A deleted link releases its slug, so this new link answers at the old
    // address. Without an invalidation on create it would serve the retired
    // link's cached page to the first customers who found it.
    await createBookingLink(
      fixture.business.id,
      createBookingLinkSchema.parse({ name: 'Main page again', slug: link.slug, type: 'CATALOG' }),
      actor(),
      metadata,
    );

    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });
});

/**
 * The workspace-level rows a page quotes but no link owns.
 *
 * These matter separately because they are wired differently. `updateBusiness`
 * and `updateSettings` do not open a transaction — each commits its own
 * statement and returns — so they drop the pages immediately rather than on an
 * `afterCommit` hook that would never fire. Getting that backwards is silent:
 * the call type-checks, and the invalidation simply never happens.
 */
describe('workspace-level mutations', () => {
  it('drops the pages when a provider is taken off the diary', async () => {
    const link = await publishLink('Main page');

    await updateStaffProfile(
      fixture.business.id,
      fixture.staffProfile.id,
      updateStaffSchema.parse({ isBookable: false }),
      actor(),
      metadata,
    );

    // Otherwise the page keeps offering someone the workspace has just stopped
    // offering, and a customer books time with them.
    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops the pages when a site is added and again when it is retired', async () => {
    const link = await publishLink('Main page');

    const location = await createLocation(
      fixture.business.id,
      createLocationSchema.parse({ name: 'Riverside branch', type: 'PHYSICAL' }),
      actor(),
      metadata,
    );
    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));

    dropped.mockClear();
    await deleteLocation(fixture.business.id, location.id, actor(), metadata);
    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops the pages when the workspace is renamed, without a transaction to hang the drop on', async () => {
    const link = await publishLink('Main page');

    await updateBusiness(fixture.business.id, { name: 'Riverside Clinic' }, actor(), metadata);

    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });

  it('drops the pages when booking policy changes', async () => {
    const link = await publishLink('Main page');

    // The notice period is quoted to the customer before they choose a time,
    // so a page cached under the old one misstates the rules they are agreeing
    // to.
    await updateSettings(fixture.business.id, { minNoticeMinutes: 720 }, actor(), metadata);

    expect(droppedKeys()).toContain(RedisKeys.bookingLinkConfig(link.slug));
  });
});
