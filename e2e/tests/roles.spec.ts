/**
 * The four-role model, from a browser.
 *
 * Delete this file and the product ships with no end-to-end evidence that a
 * role restricts anything. Every other spec in the suite registers an owner —
 * `grep -rn "MANAGER\|RECEPTIONIST\|STAFF" e2e` used to return nothing at all —
 * so the whole authorisation model was proved only by unit and integration
 * tests against the server, and never once against the client that decides
 * which controls a member is even offered. That gap is what allows the two
 * regressions this file exists to catch:
 *
 *  - **A `:own` scope quietly widening.** `appointments:read:own` narrows the
 *    diary to the caller's own provider profile. If that narrowing is lost —
 *    a missing `scopeWhere`, a role template gaining `appointments:read`, an
 *    override applied in the wrong direction — every therapist in every
 *    workspace can read every colleague's client list, and nothing else in the
 *    suite would notice. "A staff member sees their own bookings and not the
 *    whole diary" is the assertion that notices.
 *  - **The sidebar and the route guard drifting apart.** They are declared in
 *    two files (`components/layout/navigation.ts` and `routes/index.tsx`), and
 *    when they disagree a member is offered a link that refuses them when they
 *    click it. That is worse than no link: it reads as a broken product rather
 *    than as a boundary, and it teaches people to distrust the navigation. The
 *    sidebar tests below walk every link each role can see and open it.
 *
 * A note on what is *not* asserted here. Several pages a role can legitimately
 * open have nothing on them for that particular person — a receptionist holds
 * `appointments:read`, so "My schedule" appears in their sidebar, but they are
 * not a provider and the page says so. That is an empty state, not a refusal,
 * and the difference is the line these tests draw: the refusal
 * `ProtectedRoute` renders is a permission problem and must never appear
 * behind a link the sidebar offered; an empty state is the page answering
 * honestly and is allowed.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  apiCall,
  bookPublicSlot,
  createBookableWorkspace,
  fetchPublicSlots,
  listAppointments,
  statusOf,
  uniqueEmail,
  uniqueName,
  TEST_TIMEZONE,
  type OwnerFixture,
  type PublicSlot,
} from '../fixtures/api';
import {
  inviteColleague,
  makeProvider,
  roleFor,
  type MemberFixture,
  type ProviderFixture,
} from '../fixtures/members';
import { signInAsOwner } from '../fixtures/ui';

/** The heading `ProtectedRoute` renders when a role cannot open a page. */
const ACCESS_REFUSAL = 'You do not have access to this page';

/** The sentence beneath it, which is the part that tells the member what to do. */
const ACCESS_REFUSAL_REASON =
  'Your role in this workspace does not include this area. An owner or manager can change that.';

/** What `NotFoundPage` says. Asserted absent: a refusal must not read as a typo. */
const NOT_FOUND = 'This page does not exist';

/**
 * Sidebar labels whose page is titled something else.
 *
 * Every other link's label is exactly its destination's `<h1>`, which is what
 * lets the walks below assert "this link went where it said it would" without
 * a lookup table per role. `My profile` is the one deliberate exception: it
 * opens the account page, which is shared with the customer portal and is
 * titled for the person rather than for their membership.
 */
const PAGE_HEADING: Record<string, string> = { 'My profile': 'Your account' };

/**
 * What a Staff member's sidebar should contain, in order.
 *
 * Written out rather than derived, because deriving it from the permission
 * catalogue would only restate the code under test. If a navigation entry is
 * added or its permission changes, this list fails — and that failure is the
 * prompt to decide what the new page means for each role, which is a decision
 * nobody makes by accident.
 */
const STAFF_SIDEBAR = [
  'Dashboard',
  'Calendar',
  'Appointments',
  'Customers',
  'Services',
  'Locations',
  'Staff',
  'Availability',
  'My schedule',
  'My availability',
  'My services',
  'Settings',
  'My profile',
];

/** The same, for the front desk: the whole diary and the waitlist, no insight. */
const RECEPTIONIST_SIDEBAR = [
  'Dashboard',
  'Calendar',
  'Appointments',
  'Waitlist',
  'Customers',
  'Booking links',
  'Services',
  'Resources',
  'Locations',
  'Staff',
  'Teams',
  'Availability',
  'My schedule',
  'My services',
  'Settings',
  'My profile',
];

let workspace: OwnerFixture;
let staff: ProviderFixture;
let receptionist: MemberFixture;
let manager: MemberFixture;

/** The staff member's own booking, and one belonging to the owner. */
let mineReference: string;
let theirsReference: string;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('roles');

  // Sequential rather than parallel: `POST /members/invite` and the staff-profile
  // call both write to the same workspace, and a spec that raced its own setup
  // would be testing the concurrency of the fixtures instead of the product.
  staff = await makeProvider(workspace, await inviteColleague(workspace, 'STAFF'));
  receptionist = await inviteColleague(workspace, 'RECEPTIONIST');
  manager = await inviteColleague(workspace, 'MANAGER');

  // One booking on each provider. Both are needed: proving a staff member sees
  // their own booking says nothing on its own — an empty diary would satisfy
  // half of it — so there has to be a booking they must *not* see.
  mineReference = await bookWith(staff.staffProfileId, 'Mine');
  theirsReference = await bookWith(workspace.staffProfileId, 'Theirs');
});

/**
 * Books the first opening a named provider is offering, and returns its handle.
 *
 * Named rather than delegated to `bookAppointment` in the API fixtures: that
 * helper takes whichever opening comes first regardless of who is on it, and
 * *whose* diary a booking lands in is this file's entire subject. Capacity is
 * one, so an opening this provider has already had booked stops being offered
 * to them — which is why every call can take the first of theirs and no two
 * calls contend.
 */
async function bookWith(staffProfileId: string, firstName: string): Promise<string> {
  const slot = await slotFor(staffProfileId);
  const confirmation = await bookPublicSlot(
    workspace.bookingSlug,
    {
      serviceId: workspace.serviceId,
      staffProfileId,
      startsAt: slot.startsAt,
      timezone: TEST_TIMEZONE,
      customer: { firstName, lastName: 'ByApi', email: uniqueEmail('customer') },
    },
    crypto.randomUUID(),
  );
  return confirmation.appointment.publicId;
}

/**
 * The first opening one provider is offering.
 *
 * The provider is named in the *request*, not filtered out of the reply, and
 * that is not interchangeable: Smart Match assigns each opening to a single
 * person, so a workspace whose two providers keep identical hours publishes one
 * slot at 9:00 rather than two, and filtering afterwards returns nothing at all
 * for whichever of them lost the match. Asking per provider is the only way to
 * put a booking in a chosen diary.
 */
async function slotFor(staffProfileId: string): Promise<PublicSlot> {
  const slots = await fetchPublicSlots(workspace.bookingSlug, workspace.serviceId, {
    staffProfileId,
  });
  const slot = slots[0];
  if (!slot) {
    throw new Error(
      `Provider ${staffProfileId} is offering no openings on link ${workspace.bookingSlug}. ` +
        'Either their working hours or their place on the service roster did not stick.',
    );
  }
  return slot;
}

/**
 * Signs a colleague in and waits for the management shell.
 *
 * `signInAsOwner` is what does the work, and the fact that it needs no change
 * for a Staff member is itself the first thing this file establishes:
 * `/app/dashboard` carries no permission at all, so every role lands on the
 * same screen and the sidebar underneath it is the only thing that differs.
 */
async function signInAsMember(page: Page, member: MemberFixture): Promise<void> {
  await signInAsOwner(page, member.email, member.password);
}

/** Every label in the workspace sidebar, in the order it is rendered. */
async function sidebarLabels(page: Page): Promise<string[]> {
  const contents = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .allTextContents();
  return contents.map((label) => label.trim()).filter((label) => label.length > 0);
}

/**
 * Clicks one sidebar link and proves it led somewhere the caller can read.
 *
 * Two assertions, and the second is the point of the exercise. The heading
 * confirms the link went where its label promised; the absence of the refusal
 * confirms the navigation and the route guard still agree about this page. A
 * link that appears and then refuses is the failure this whole helper exists
 * to make impossible to ship.
 */
async function openFromSidebar(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: label, exact: true })
    .click();

  await expect(
    page.getByRole('heading', { level: 1, name: PAGE_HEADING[label] ?? label }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Staff: the narrowest role, and the one `:own` scoping exists for
// ---------------------------------------------------------------------------

test.describe('a staff member', () => {
  test('sees their own bookings and not the whole diary', async ({ page }) => {
    // The API first, because the browser can only ever show what this returns.
    const visible = await listAppointments({
      token: staff.token,
      businessId: workspace.businessId,
    });
    const references = visible.map((appointment) => appointment.publicId);
    expect(references).toContain(mineReference);
    expect(references).not.toContain(theirsReference);

    // And the workspace itself really does hold both, so the absence above is
    // a scope and not an empty diary.
    const everything = (await listAppointments(workspace)).map(
      (appointment) => appointment.publicId,
    );
    expect(everything).toEqual(expect.arrayContaining([mineReference, theirsReference]));

    // --- The same question, from the diary they actually use ---------------
    await signInAsMember(page, staff);
    await page.goto('/app/appointments');
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible();

    const table = page.getByRole('table', { name: 'Appointments' });
    /*
     * Addressed by role rather than by `getByLabel('Search')`.
     *
     * A search field that has text in it also grows a "Clear search" button,
     * and `getByLabel` matches accessible names by substring — so the moment
     * the box is not empty, that locator resolves to two elements and the next
     * fill fails on strict mode. Every other spec searches exactly once from
     * empty and never meets this; a spec that searches twice does.
     */
    const search = page.getByRole('searchbox', { name: 'Search' });

    await search.fill(mineReference);
    // One header row plus exactly one match: a count of 1 would mean the search
    // found nothing, and anything above 2 would mean it did not narrow.
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row').last()).toContainText(staff.staffName);

    await search.fill(theirsReference);
    // Not "an empty table" — the page swaps the table out for an empty state,
    // so the table's absence is what proves nothing matched. Asserting on row
    // counts alone would pass against a table that failed to render at all.
    await expect(
      page.getByRole('heading', { name: 'No appointment matches these filters' }),
    ).toBeVisible();
    await expect(table).toHaveCount(0);

    // Their own schedule, meanwhile, is populated — which is what makes the
    // narrowing a scope rather than a blanket refusal.
    await page.goto('/app/my/schedule');
    await expect(page.getByRole('heading', { level: 1, name: 'My schedule' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'You are not set up as a provider here' }),
    ).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('Mine ByApi');
  });

  test('is refused workspace configuration in place, and told why', async ({ page }) => {
    // The server's answer first. 403, not 404 — and the distinction is the
    // whole point: `tenancy.spec.ts` proves that another tenant's workspace is
    // indistinguishable from one that does not exist, because confirming it
    // exists would leak. Inside your *own* workspace there is nothing to hide,
    // so the honest answer names the permission instead of pretending the
    // endpoint is not there.
    const ctx = { token: staff.token, businessId: workspace.businessId };
    expect(await statusOf(apiCall('/api/v1/members', ctx))).toBe(403);
    expect(await statusOf(apiCall('/api/v1/analytics/overview', ctx))).toBe(403);

    await signInAsMember(page, staff);
    await page.goto('/app/members');

    await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toBeVisible();
    await expect(page.getByText(ACCESS_REFUSAL_REASON)).toBeVisible();

    // Refused where they asked, not bounced somewhere else. The address they
    // typed is still the address they are on, which is what makes the
    // explanation an answer to the question they actually had.
    await expect(page).toHaveURL(/\/app\/members$/);
    // And emphatically not a 404. "This page does not exist" would send a
    // member hunting for a broken link instead of asking for a permission.
    await expect(page.getByRole('heading', { name: NOT_FOUND })).toHaveCount(0);

    // The same refusal on a second area, so this is the guard and not one
    // page's own empty state.
    await page.goto('/app/analytics');
    await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toBeVisible();

    // A refusal without a way out is a dead end.
    await page.getByRole('link', { name: 'Back to your dashboard' }).click();
    await expect(page).toHaveURL(/\/app(\/dashboard)?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Receptionist: runs the diary, changes no configuration
// ---------------------------------------------------------------------------

test.describe('a receptionist', () => {
  test('books and keeps the customer list, and can change neither the catalogue nor a role', async ({
    page,
  }) => {
    const ctx = { token: receptionist.token, businessId: workspace.businessId };

    // --- What the front desk is for ---------------------------------------
    const customer = await apiCall<{ id: string }>('/api/v1/customers', {
      ...ctx,
      method: 'POST',
      body: { firstName: 'Walk', lastName: 'In', email: uniqueEmail('walkin') },
    });
    expect(customer.id).toBeTruthy();

    const slot = await slotFor(workspace.staffProfileId);
    const booked = await apiCall<{ appointment: { publicId: string; status: string } }>(
      '/api/v1/appointments',
      {
        ...ctx,
        method: 'POST',
        body: {
          serviceId: workspace.serviceId,
          staffProfileId: workspace.staffProfileId,
          startsAt: slot.startsAt,
          timezone: TEST_TIMEZONE,
          customer: { firstName: 'Phoned', lastName: 'In', email: uniqueEmail('phoned') },
        },
      },
    );
    expect(booked.appointment.publicId).toMatch(/^apt_/);

    // Booked on somebody else's behalf, and it really did land in the workspace
    // diary rather than in a reply this test made up.
    const diary = (await listAppointments(workspace)).map((appointment) => appointment.publicId);
    expect(diary).toContain(booked.appointment.publicId);

    // --- What it is not for ------------------------------------------------
    // The catalogue: a receptionist reads it — every booking they take names a
    // service — and may not rewrite what the workspace sells.
    expect(
      await statusOf(
        apiCall('/api/v1/services', {
          ...ctx,
          method: 'POST',
          body: { name: uniqueName('Receptionist service'), durationMinutes: 30 },
        }),
      ),
    ).toBe(403);

    // Authority: neither the member list, nor a role, nor one person's
    // exceptions. Three separate permissions, refused separately, because a
    // regression that granted one of them would not grant the others.
    expect(await statusOf(apiCall('/api/v1/members', ctx))).toBe(403);
    expect(
      await statusOf(
        apiCall(`/api/v1/members/${staff.membershipId}`, {
          ...ctx,
          method: 'PATCH',
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).toBe(403);
    expect(
      await statusOf(
        apiCall(`/api/v1/members/${staff.membershipId}/permissions`, {
          ...ctx,
          method: 'PUT',
          body: { overrides: [{ permission: 'appointments:read', effect: 'GRANT' }] },
        }),
      ),
    ).toBe(403);

    // --- And the page offers exactly that ----------------------------------
    await signInAsMember(page, receptionist);

    await page.goto('/app/customers');
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add customer' })).toBeVisible();

    // The catalogue opens — it has to, or they could not take a booking — but
    // the control that would change it is absent rather than present and
    // refusing.
    await page.goto('/app/services');
    await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeVisible();
    await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add service' })).toHaveCount(0);

    await page.goto('/app/members');
    await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Manager: every operation, none of the authority
// ---------------------------------------------------------------------------

test.describe('a manager', () => {
  test('runs the workspace but cannot change what a role is allowed to do', async ({ page }) => {
    const ctx = { token: manager.token, businessId: workspace.businessId };

    // --- Operations --------------------------------------------------------
    const service = await apiCall<{ id: string }>('/api/v1/services', {
      ...ctx,
      method: 'POST',
      body: { name: uniqueName('Manager service'), durationMinutes: 45 },
    });
    expect(service.id).toBeTruthy();

    // People, too: a manager decides who does which job. Reading the roles back
    // through their own session is half the assertion — naming a role is what
    // an invitation requires, and `roles:read` is the grant that allows it.
    const staffRole = await roleFor(ctx, 'STAFF');
    const invited = await apiCall<{ id: string; status: string }>('/api/v1/members/invite', {
      ...ctx,
      method: 'POST',
      body: { email: uniqueEmail('invited-by-manager'), roleId: staffRole.id },
    });
    expect(invited.status).toBe('INVITED');

    // --- Authority ---------------------------------------------------------
    // The line a Manager does not cross: they may change who holds a job, not
    // what a job is allowed to do, and they cannot take somebody's access away.
    // Both are the guards that stop an operational role escalating itself.
    expect(
      await statusOf(
        apiCall(`/api/v1/members/${staff.membershipId}/permissions`, {
          ...ctx,
          method: 'PUT',
          body: { overrides: [{ permission: 'roles:manage', effect: 'GRANT' }] },
        }),
      ),
    ).toBe(403);
    expect(
      await statusOf(
        apiCall(`/api/v1/members/${staff.membershipId}`, { ...ctx, method: 'DELETE' }),
      ),
    ).toBe(403);

    // --- And the member panel says so, rather than offering a dead button ---
    await signInAsMember(page, manager);
    await page.goto('/app/members');
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite someone' })).toBeVisible();

    // By email address: every fixture account shares one person-name, and the
    // address is the field that is unique per run.
    await page.getByLabel('Search').fill(staff.email);
    const members = page.getByRole('table', { name: /Members of this workspace/i });
    await expect(members.getByRole('row')).toHaveCount(2);
    await members.getByRole('row').last().getByRole('button', { name: 'Manage' }).click();

    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    // Read, not write. An owner is offered "Review overrides"; the wording is
    // the panel admitting up front that this manager can only look.
    await expect(panel.getByRole('button', { name: 'View overrides' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Review overrides' })).toHaveCount(0);
    // And removal is explained rather than silently missing.
    await expect(
      panel.getByText(/Removing somebody needs the members:remove permission/i),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The sidebar: what each role is offered, and whether it opens
// ---------------------------------------------------------------------------

test.describe('the sidebar', () => {
  test('offers a staff member their own corner of the workspace, and nothing that refuses them', async ({
    page,
  }) => {
    await signInAsMember(page, staff);
    expect(await sidebarLabels(page)).toEqual(STAFF_SIDEBAR);

    for (const label of STAFF_SIDEBAR) await openFromSidebar(page, label);
  });

  test('offers a receptionist the front desk, and nothing that refuses them', async ({ page }) => {
    await signInAsMember(page, receptionist);
    expect(await sidebarLabels(page)).toEqual(RECEPTIONIST_SIDEBAR);

    for (const label of RECEPTIONIST_SIDEBAR) await openFromSidebar(page, label);

    // "My schedule" is in that list and a receptionist is not a provider, so
    // the page has nothing to draw. It says so, and that is the distinction
    // this file keeps: an empty state is a page answering honestly, whereas the
    // refusal above is the guard turning somebody away. Only the second one is
    // a link that should never have been shown.
    await page.goto('/app/my/schedule');
    await expect(
      page.getByRole('heading', { name: 'You are not set up as a provider here' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: ACCESS_REFUSAL })).toHaveCount(0);
  });

  test('offers a manager everything the owner sees — the difference is inside the pages', async ({
    browser,
  }) => {
    /*
     * Compared against a live owner session rather than a written-out list.
     *
     * No navigation entry is gated on the three grants a Manager lacks
     * (`roles:manage`, `members:remove`, `workspace:delete`), so the two
     * sidebars are identical by construction — and stating that as a
     * comparison rather than as another literal array is what keeps this test
     * true when a page is added. What separates the roles is what each page
     * offers once open, which the manager test above asserts directly.
     *
     * `Messages` is the page that tested this most recently: it is gated on
     * `templates:manage`, which reads like an owner-only grant and is not one —
     * `MANAGER_PERMISSIONS` carries it, because a manager running the workspace
     * day to day is exactly who rewrites a confirmation email. This assertion
     * is what said so.
     */
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await signInAsOwner(ownerPage, workspace.email, workspace.password);
    const ownerLabels = await sidebarLabels(ownerPage);
    await ownerContext.close();

    expect(ownerLabels.length, 'the owner should see the whole sidebar').toBeGreaterThan(
      STAFF_SIDEBAR.length,
    );

    const managerContext = await browser.newContext();
    const managerPage = await managerContext.newPage();
    await signInAsMember(managerPage, manager);

    expect(await sidebarLabels(managerPage)).toEqual(ownerLabels);
    for (const label of ownerLabels) await openFromSidebar(managerPage, label);

    await managerContext.close();
  });
});
