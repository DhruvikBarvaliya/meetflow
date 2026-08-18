/**
 * The platform-administration panel.
 *
 * This is the one spec in the suite that reads seeded data, and the dependency
 * is worth stating plainly rather than hiding. Every other spec mints its
 * identities through the real API, so it can never pass against a state the
 * product itself could not produce. There is no such route to a platform
 * administrator: `platformRole` is not settable by registration — the auth
 * schemas are `.strict()`, so a stray `platformRole` in the body is a 422 — and
 * the one endpoint that can grant it, `PATCH /admin/users/:id/platform-role`, sits behind
 * `requirePlatformAdmin` and therefore behind an administrator who already
 * exists. That closed loop is the design, not an omission: platform admin is
 * granted out of band, by whoever runs the deployment. So the operator here is
 * `admin@meetflow.dev` from
 * server/seeders/20250201000100-seed-demo-workspace.js, and the demo tenant
 * that seeder builds is the subject of the reads below.
 *
 * Because that dependency is real, the spec verifies it instead of assuming it.
 * `seededAdministratorProblem()` signs in through the API before a browser is
 * opened, and every test that needs the operator skips with a sentence naming
 * what to run — a missing account, a changed `SEED_DEFAULT_PASSWORD` or an
 * account that is no longer an administrator all produce an honest skip rather
 * than eight selector failures on an unseeded database.
 *
 * The refusal test at the top needs none of that: it builds its own ordinary
 * user through the fixtures, which is exactly the account the guard exists to
 * turn away. It is deliberately outside the seed guard so that the most
 * security-relevant assertion in the file runs on every database.
 *
 * Nothing here suspends a workspace or an account. The reason, and where that
 * behaviour *is* proved, is written out beside the controls in
 * "the workspace register finds the demo tenant and opens it".
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiCall, createBookableWorkspace } from '../fixtures/api';
import { signInAsOwner } from '../fixtures/ui';

/**
 * The seeded operator.
 *
 * `MeetFlow!Demo123` is the seeder's `DEFAULT_PASSWORD`, which
 * `SEED_DEFAULT_PASSWORD` can override — one of the cases the guard below turns
 * into a skip rather than a failure.
 */
const ADMIN = {
  email: 'admin@meetflow.dev',
  password: 'MeetFlow!Demo123',
  fullName: 'Aarav Krishnan',
};

/** The demo tenant the same seeder builds, and the account that owns it. */
const DEMO = {
  workspace: 'Aurora Wellness Studio',
  slug: 'aurora-wellness-studio',
  ownerEmail: 'priya.shah@aurorawellness.test',
  ownerName: 'Priya Shah',
  ownerRole: 'Business Owner',
};

/**
 * Table captions, which is what `getByRole('table', { name })` matches on.
 *
 * Held as constants because two of them are asserted from more than one test,
 * and a caption reworded in the page should break this file in one obvious
 * place rather than in three scattered selectors.
 */
const WORKSPACE_TABLE = 'Workspaces on this deployment, with their owner and their totals.';
const USER_TABLE = 'Every account on this platform, with its role, standing and workspace count.';
const MEMBER_TABLE = 'People who hold a membership in this workspace, with their role.';
const MEMBERSHIP_TABLE = 'Workspaces this account belongs to, with its role and standing in each.';
const AUDIT_TABLE = 'Audited actions across every workspace on this deployment, newest first.';

/** Shown beside both self-service controls on an operator's own account. */
const SELF_GUARD = 'You cannot change your own account status or role. Ask another administrator.';

// ---------------------------------------------------------------------------
// Reading the panel
// ---------------------------------------------------------------------------

/**
 * The total a paginated register reports.
 *
 * Read from the pagination summary rather than counted from the rows, because
 * the rows are one capped page of twenty and the question these tests ask is
 * whether a filter narrowed the whole set. Everything after " of " is stripped
 * to digits: `formatNumber` groups in the browser's locale and `en-IN` writes
 * 100000 as 1,00,000, while no item label the component is given carries a
 * digit, so the strip is unambiguous where guessing the separator would not be.
 *
 * Returns `NaN` rather than throwing when no total is on screen, so it can be
 * polled: an assertion that retries is what a caller needs while a filtered
 * page is still in flight, and a thrown error would end the attempt instead.
 */
async function reportedTotal(scope: Locator): Promise<number> {
  const summary = scope.getByRole('navigation', { name: 'Pagination' }).locator('p');
  const text = ((await summary.textContent()) ?? '').trim();
  const [, tail] = text.split(' of ');
  const digits = (tail ?? '').replace(/\D/g, '');
  return digits === '' ? Number.NaN : Number(digits);
}

/**
 * The figure one stat tile is showing.
 *
 * A tile is a card with no role of its own, so it is addressed through its
 * label — the only string on it that is not a number — and the figure is the
 * paragraph immediately after that label. The value is parsed back to a number
 * rather than compared as text, for the same locale-grouping reason as above.
 *
 * Callers should still gate on the page's data having arrived — it makes a
 * failure read as "the overview never loaded" rather than "a tile never settled"
 * — but this helper no longer depends on them doing so. See the poll below.
 */
async function tileFigure(scope: Locator, label: string): Promise<number> {
  const value = scope.getByText(label, { exact: true }).locator('xpath=following-sibling::p[1]');

  /*
   * Polled, and checked against the shape of a formatted number rather than
   * merely read once.
   *
   * The tile's figure is the paragraph after its label — but only once the
   * figure exists. While the request is in flight StatTile renders a skeleton
   * there instead, and this locator then resolves to whatever paragraph comes
   * next. Reading it blind is how a caption sitting lower in the tile gets
   * parsed as the headline number, which is a wrong answer that passes rather
   * than an error: `replace(/\D/g, '')` will happily reduce "0 archived" to a
   * confident zero.
   *
   * So keep polling until the text is a number and nothing else. A tile mid-load
   * simply fails to match and is waited out; a tile that never settles fails
   * loudly with the message below instead of returning a plausible figure.
   */
  await expect
    .poll(async () => ((await value.textContent().catch(() => null)) ?? '').trim(), {
      message: `the "${label}" tile never settled on a figure`,
    })
    // Digits, with the group separators `formatNumber` may insert — including the
    // non-breaking and narrow no-break spaces some locales use.
    .toMatch(/^\d[\d,.   ]*$/);

  return Number(((await value.textContent()) ?? '').replace(/\D/g, ''));
}

/**
 * Why this spec might legitimately not run, or `null` if it can.
 *
 * Signs in as the seeded operator through the API and reads the platform role
 * back, so the skip message can distinguish "there is no such account" from
 * "that account is not an administrator" — two different things to fix.
 */
async function seededAdministratorProblem(): Promise<string | null> {
  try {
    const session = await apiCall<{ user: { platformRole: string } }>('/api/v1/auth/login', {
      method: 'POST',
      body: { email: ADMIN.email, password: ADMIN.password },
    });

    if (session.user.platformRole !== 'ADMIN') {
      return (
        `${ADMIN.email} signs in, but its platform role is ${session.user.platformRole} rather ` +
        'than ADMIN. Platform administration cannot be granted through the API, so there is ' +
        'nothing this spec can sign in as. Re-run the demo seeder to restore it.'
      );
    }
    return null;
  } catch (error) {
    return (
      `Could not sign in as the seeded platform administrator ${ADMIN.email}. This spec is the ` +
      'only one in the suite that needs seeded data, because platform admin cannot be ' +
      'self-served — run SEED_ENABLED=true npm run db:seed from the repository root. The API ' +
      // Appended last and without punctuation after it, because the server's
      // messages end in a full stop of their own.
      `said: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// The guard, on an account that has no business being here
// ---------------------------------------------------------------------------

test.describe('an account without the platform role', () => {
  test('is refused at /admin and told plainly why', async ({ page }) => {
    // A perfectly ordinary owner: a real account, a real workspace, built the
    // way every other spec builds one. Nothing about them is malformed — the
    // only thing they lack is the one bit that opens this surface.
    const owner = await createBookableWorkspace('nonadmin');
    await signInAsOwner(page, owner.email, owner.password);

    await page.goto('/admin');

    await expect(
      page.getByRole('heading', { name: 'This account is not a platform administrator' }),
    ).toBeVisible();
    await expect(
      page.getByText('The platform area is limited to operators of this deployment.'),
    ).toBeVisible();

    // Refused in place rather than bounced: the address they asked for is still
    // the address they are on, which is what makes the explanation an answer to
    // the question they actually have.
    await expect(page).toHaveURL(/\/admin$/);

    // And nothing of the platform shell rendered behind the refusal. The banner
    // and the platform sidebar are the two things an operator sees; if either
    // is present for this account, the guard is decorative.
    await expect(page.getByRole('note')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Platform' })).toHaveCount(0);

    // The refusal is not a dead end, and their own workspace is untouched by it.
    await page.getByRole('link', { name: 'Back to my workspace' }).click();
    await expect(page).toHaveURL(/\/app(\/dashboard)?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The panel itself
// ---------------------------------------------------------------------------

/**
 * One operator, one session, walked through the panel in the order a real one
 * would. Serial and sharing a page: signing in eight times to assert eight
 * screens would test the login form seven more times than it tests the panel.
 */
test.describe('platform administration', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;

  /** Non-null when the seeded operator is unusable; every test then skips with it. */
  let unavailable: string | null = null;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    unavailable = await seededAdministratorProblem();
    // Signing in through the UI is left undone when there is nothing to sign in
    // as: it would fail inside a hook, and a failing hook reports itself rather
    // than the skip reason that explains it.
    if (unavailable === null) await signInAsOwner(page, ADMIN.email, ADMIN.password);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.beforeEach(() => {
    test.skip(unavailable !== null, unavailable ?? '');
  });

  /** The platform sidebar is the only navigation this shell has, so the tests use it. */
  async function navigateTo(target: string): Promise<void> {
    await page
      .getByRole('navigation', { name: 'Platform' })
      .getByRole('link', { name: target })
      .click();
    // Level 1 specifically: an empty state's own heading can carry the same
    // words and would otherwise trip strict mode.
    await expect(page.getByRole('heading', { level: 1, name: target })).toBeVisible();
  }

  test('the operator reaches the panel from the account menu', async () => {
    // The seeded operator holds an ordinary receptionist membership in the demo
    // tenant, so signing in lands them in the tenant app like anybody else.
    // Platform administration is a property of the account, not of that
    // membership, which is why the way in is the account menu and not the
    // workspace sidebar.
    await expect(page).toHaveURL(/\/app(\/dashboard)?$/);

    await page.getByRole('button', { name: `Account menu for ${ADMIN.email}` }).click();
    await page.getByRole('menuitem', { name: 'Platform administration' }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    // The banner is the whole point of the second shell: the cue that the rows
    // below this line belong to other people's businesses. It sits inside the
    // sticky region so it cannot be scrolled away, and an operator who loses it
    // is one who forgets which application they are typing into.
    const banner = page.getByRole('note');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('you are acting across every workspace on this deployment');
  });

  test('the overview counts the workspaces and the accounts on the deployment', async () => {
    await navigateTo('Overview');

    // "Counted …" renders only once the response is in hand, so waiting on it
    // is what makes the two figures below the real figures rather than a
    // loading state. It is the gate, not the guarantee — `tileFigure` polls for
    // a number in its own right, because a tile caught mid-load once put a
    // caption where this test expected the headline figure.
    await expect(page.getByText(/^Counted /)).toBeVisible();

    const main = page.getByRole('main');

    // Both are live counts over the real tables — there is no rollup behind
    // them — so the honest assertion is that the platform holds at least the
    // demo tenant and the accounts in it, not some exact number this spec would
    // have to keep in step with the seeder.
    expect(await tileFigure(main, 'Workspaces')).toBeGreaterThan(0);
    expect(await tileFigure(main, 'People')).toBeGreaterThan(0);
  });

  test('the workspace register finds the demo tenant and opens it', async () => {
    await navigateTo('Workspaces');

    const table = page.getByRole('table', { name: WORKSPACE_TABLE });
    await expect(table).toBeVisible();

    const main = page.getByRole('main');
    const everything = await reportedTotal(main);
    expect(everything, 'the register should report how many workspaces exist').toBeGreaterThan(0);

    // Searching rather than paging to it: the register is newest-first, and
    // every previous run of this suite has left a workspace in front of the
    // demo one. A spec that walked pages hunting for a row would be asserting
    // on the page size as much as on the register.
    await page.getByLabel('Search').fill(DEMO.workspace);

    // One header row and exactly one match. A count of 1 would mean the search
    // found nothing; more than 2 would mean it did not actually narrow.
    await expect(table.getByRole('row')).toHaveCount(2);
    // The rows above and this total come from the same response, so once the
    // rows are the narrowed rows the total is the narrowed total.
    expect(await reportedTotal(main)).toBeLessThan(everything);

    const row = table.getByRole('row').last();
    await expect(row).toContainText(`/${DEMO.slug}`);
    // Who is answerable for the workspace — the column that makes this register
    // useful to somebody handling a support request about it.
    await expect(row).toContainText(DEMO.ownerEmail);

    await row.getByRole('link', { name: DEMO.workspace }).click();
    await expect(page.getByRole('heading', { level: 1, name: DEMO.workspace })).toBeVisible();

    // Members, not customers: the admin API carries who administers a workspace
    // and has no field at all for who books with it.
    const members = page.getByRole('table', { name: MEMBER_TABLE });
    await expect(members).toBeVisible();
    await expect(members.getByRole('row', { name: new RegExp(DEMO.ownerName, 'i') })).toContainText(
      DEMO.ownerRole,
    );

    /*
     * The lifecycle controls are right here, and this spec stops at looking at
     * them.
     *
     * Suspending the demo workspace would take the rest of the suite and the
     * developer's own running stack down with it: `requireTenant` joins through
     * `businesses` on `status = 'ACTIVE'`, so a suspended demo tenant 404s every
     * request its five members make, and the state persists after the run. The
     * same goes for deactivating a seeded account.
     *
     * What suspension actually does is proved end to end against a database
     * that is torn down afterwards — see "suspending a workspace" and
     * "suspending a user" in server/tests/integration/admin.test.ts. So the
     * assertion worth making from a browser is that the control is offered and
     * live, which is the part those tests cannot see.
     */
    await expect(page.getByRole('heading', { level: 2, name: 'Workspace status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspend workspace' })).toBeEnabled();
  });

  test('the account register finds the demo owner and lists their memberships', async () => {
    await navigateTo('Users');

    const table = page.getByRole('table', { name: USER_TABLE });
    await expect(table).toBeVisible();

    // By email address, because that is the handle a support conversation
    // starts from and it is the one field on the account that is unique.
    await page.getByLabel('Search').fill(DEMO.ownerEmail);
    await expect(table.getByRole('row')).toHaveCount(2);

    const row = table.getByRole('row').last();
    await expect(row).toContainText(DEMO.ownerEmail);
    await row.getByRole('link', { name: DEMO.ownerName }).click();

    await expect(page.getByRole('heading', { level: 1, name: DEMO.ownerName })).toBeVisible();

    // Membership, never contents: the workspaces this person can reach and in
    // what capacity, with nothing from inside any of them.
    const memberships = page.getByRole('table', { name: MEMBERSHIP_TABLE });
    await expect(memberships).toBeVisible();

    const membership = memberships.getByRole('row', { name: new RegExp(DEMO.workspace, 'i') });
    await expect(membership).toContainText(DEMO.ownerRole);
    // Still active. This spec suspends nothing, and reading the standing back
    // from the panel is the cheapest proof that it left the seed data alone.
    await expect(membership).toContainText('Active');
  });

  test('the audit feed loads and narrows to one workspace', async () => {
    await navigateTo('Audit log');

    const table = page.getByRole('table', { name: AUDIT_TABLE });
    await expect(table).toBeVisible();

    const main = page.getByRole('main');
    const everything = await reportedTotal(main);
    expect(everything, 'the trail should report how many entries it holds').toBeGreaterThan(0);

    // `selectOption` hands back the values it selected, so the workspace id
    // comes from the picker rather than being written into this file. A spec
    // that hard-coded a uuid would be asserting on the seeder.
    // Exact: the topbar's "Back to my workspace" link carries an aria-label
    // that contains this one, and a substring match picks up both.
    const [businessId] = await page
      .getByLabel('Workspace', { exact: true })
      .selectOption({ label: DEMO.workspace });
    expect(businessId, 'the picker should offer the demo workspace').toBeTruthy();

    // The feed keeps the previous page on screen while the next one loads, so
    // the assertions below have to be ones the unfiltered page cannot satisfy.
    // Every remaining row links to this one workspace: none to another, and
    // none to the platform, which is what a row with no workspace shows.
    await expect(table.getByRole('link', { name: DEMO.workspace }).first()).toBeVisible();
    await expect(
      table.locator(`a[href^="/admin/workspaces/"]:not([href="/admin/workspaces/${businessId}"])`),
    ).toHaveCount(0);
    await expect(table.getByText('Platform', { exact: true })).toHaveCount(0);

    // Polled rather than read once: the rows settling is a strong signal that
    // the filtered response has arrived, but it is not a guarantee that this
    // paragraph has repainted in the same tick.
    await expect
      .poll(async () => reportedTotal(main), {
        message: 'the audit total should fall once the trail is narrowed to one workspace',
      })
      .toBeLessThan(everything);
    expect(await reportedTotal(main)).toBeGreaterThan(0);
  });

  test('system health reports PostgreSQL as reachable', async () => {
    await navigateTo('System health');

    const postgres = page
      .getByRole('heading', { level: 2, name: 'PostgreSQL' })
      // Out of the heading's own column and out of the card header: the card is
      // the element that holds both the state badge and the measurement it was
      // derived from, and neither is a descendant of the heading.
      .locator('xpath=../../..');

    await expect(postgres.getByText('Reachable', { exact: true })).toBeVisible();
    // The round trip the badge is derived from. Without this, a card that
    // reported "Reachable" having measured nothing would still pass.
    await expect(postgres.getByText(/^[\d,]+ ms$/)).toBeVisible();
  });

  test('the operator cannot change their own standing, and the panel says why', async () => {
    await navigateTo('Users');
    await page.getByLabel('Search').fill(ADMIN.email);

    const table = page.getByRole('table', { name: USER_TABLE });
    await expect(table.getByRole('row')).toHaveCount(2);
    await table.getByRole('row').last().getByRole('link', { name: ADMIN.fullName }).click();

    await expect(page.getByRole('heading', { level: 1, name: ADMIN.fullName })).toBeVisible();

    // Once beside the status controls and once beside the role control. Saying
    // it twice is deliberate: an operator reading either card in isolation is
    // told why the buttons under it will not respond.
    await expect(page.getByText(SELF_GUARD)).toHaveCount(2);

    // And the controls are genuinely inert rather than merely captioned. The
    // server refuses all three with a 409 regardless — an administrator who
    // suspends or demotes themselves has locked themselves out of the only
    // surface that could undo it — so what is being asserted here is that the
    // panel does not offer an action it knows cannot work.
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Revoke administrator' })).toBeDisabled();
  });
});
