/**
 * Standing a workspace up, entirely through the product.
 *
 * This is the one spec that touches no API helper: every record is created the
 * way an owner creates it, in the order the product forces, because the order
 * *is* the constraint. A service with no provider, a provider with no hours, or
 * a link pointing at either publishes an empty slot grid — so the only honest
 * proof that setup worked is that the public page it produces offers real times.
 * That is what the last test asserts.
 *
 * The workspace is created without a staff profile for the owner. It is not an
 * arbitrary choice: "Add staff profile" is disabled once every member already
 * has one, so a workspace that made the owner bookable on the way in leaves the
 * Staff page with nothing to demonstrate.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { uniqueName, uniqueSlug } from '../fixtures/api';
import { createWorkspaceThroughUi, registerThroughUi, slotButtons } from '../fixtures/ui';

/** Monday-first, the order `WEEK_ORDER` renders the rota editor in. */
const WORKING_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const owner = {
  firstName: 'Priya',
  lastName: 'Shah',
};

const names = {
  workspace: uniqueName('Aurora Wellness'),
  workspaceSlug: uniqueSlug('aurora'),
  location: uniqueName('Indiranagar Studio'),
  service: uniqueName('Deep Tissue Massage'),
  staffDisplayName: uniqueName('Priya'),
  resource: uniqueName('Treatment Room'),
  bookingLink: uniqueName('Book a massage'),
  bookingSlug: uniqueSlug('massage'),
};

/**
 * These tests are one journey cut into readable steps, so they share a session
 * and run in order. Splitting the journey across independent tests would mean
 * rebuilding a workspace five times to test the fifth step.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await registerThroughUi(page, { firstName: owner.firstName, lastName: owner.lastName });
  await createWorkspaceThroughUi(page, {
    name: names.workspace,
    slug: names.workspaceSlug,
    // Left to the Staff page, which is the flow under test.
    addMeAsStaff: false,
  });
});

test.afterAll(async () => {
  await page.close();
});

/** The sidebar is the only navigation an owner has, so the specs use it. */
async function navigateTo(target: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: target }).click();
  // Level 1 specifically: an empty state's own heading ("No locations yet")
  // otherwise matches the same name and trips strict mode.
  await expect(page.getByRole('heading', { level: 1, name: target })).toBeVisible();
}

/**
 * The side sheet a form lives in.
 *
 * Addressed by its accessible name, which `Drawer` wires to its own heading —
 * so this both finds the sheet and asserts the right one opened, and never
 * collides with the confirmation dialogs that share `role="dialog"`.
 */
function openDrawer(title: string): Locator {
  return page.getByRole('dialog', { name: title });
}

test.describe('workspace setup', () => {
  test('a location is added', async () => {
    await navigateTo('Locations');
    // The page header and the empty state both offer this action; either is a
    // fine way in, so the spec takes the first rather than asserting which.
    await page.getByRole('button', { name: 'Add location' }).first().click();

    const drawer = openDrawer('Add a location');
    await drawer.getByLabel('Name').fill(names.location);
    await drawer.getByLabel('Type').selectOption({ label: 'Physical' });
    // The site keeps its own clock; it defaults to the workspace's.
    await expect(drawer.getByLabel('Timezone')).toHaveValue('Asia/Kolkata');
    // Exact: "Capacity" ends in "city", so a substring match hits both fields.
    await drawer.getByLabel('City', { exact: true }).fill('Bengaluru');
    await drawer.getByRole('button', { name: 'Add location' }).click();

    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole('table', { name: 'Locations in this workspace' }).getByRole('row', {
        name: new RegExp(names.location, 'i'),
      }),
    ).toBeVisible();
  });

  test('a service is added to the catalogue', async () => {
    await navigateTo('Services');
    await page.getByRole('button', { name: 'Add service' }).first().click();

    const drawer = openDrawer('Add a service');
    await drawer.getByLabel('Name').fill(names.service);
    await drawer.getByLabel(/^Duration/).fill('30');
    await drawer.getByLabel(/^Price/).fill('1500');
    await drawer.getByLabel(/^Capacity/).fill('1');
    await drawer.getByRole('button', { name: 'Add service' }).click();

    await expect(drawer).toBeHidden();
    const row = page
      .getByRole('table', { name: 'Service catalogue' })
      .getByRole('row', { name: new RegExp(names.service, 'i') });
    await expect(row).toBeVisible();
    // The duration is what the booking engine hands out slots on, so it is worth
    // reading back rather than trusting the form.
    await expect(row).toContainText('30 min');
  });

  test('a staff profile is created for the owner', async () => {
    await navigateTo('Staff');

    // Nobody is bookable yet, which is exactly why the button is offered.
    await expect(page.getByText('No staff profiles yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add staff profile' }).first().click();

    const drawer = openDrawer('Add a staff profile');

    // A profile is created against a membership, and the owner is the only
    // member — so the one selectable option must be them. Reading it back first
    // is what makes this an assertion rather than a blind pick by position.
    const memberSelect = drawer.getByLabel('Workspace member');
    const onlyMember = memberSelect.getByRole('option').nth(1);
    await expect(onlyMember).toContainText(`${owner.firstName} ${owner.lastName}`);
    await memberSelect.selectOption({ index: 1 });

    await drawer.getByLabel('Display name').fill(names.staffDisplayName);
    await drawer.getByRole('button', { name: 'Create profile' }).click();

    await expect(drawer).toBeHidden();
    await expect(
      page
        .getByRole('table', { name: 'Staff profiles' })
        .getByRole('row', { name: new RegExp(names.staffDisplayName, 'i') }),
    ).toBeVisible();
  });

  test('the new provider is given weekly working hours', async () => {
    await navigateTo('Staff');
    await page.getByRole('button', { name: `Working hours for ${names.staffDisplayName}` }).click();

    const drawer = openDrawer(`${names.staffDisplayName} — availability`);
    await expect(drawer.getByRole('heading', { name: 'Recurring weekly hours' })).toBeVisible();

    for (const [index, day] of WORKING_DAYS.entries()) {
      // The rota renders Monday-first, so the nth "Add window" button is the nth
      // working day — and the assertion that follows proves it, because the new
      // row's controls are labelled with the day they belong to.
      await drawer.getByRole('button', { name: 'Add window' }).nth(index).click();

      const start = drawer.getByLabel(`${day} window start`);
      const end = drawer.getByLabel(`${day} window end`);
      await expect(start).toBeVisible();
      await start.selectOption('09:00');
      await end.selectOption('17:00');
    }

    // 6 days x 8 hours, computed by the editor from the windows just entered.
    await expect(drawer.getByText('48.0 hours a week')).toBeVisible();

    await drawer.getByRole('button', { name: 'Save working hours' }).click();
    await expect(page.getByText('Working hours saved')).toBeVisible();
    // The editor reports a rejected rota in place rather than in a toast that
    // disappears, so the absence of that banner is a real signal.
    await expect(drawer.getByRole('alert')).toHaveCount(0);

    // Exact: the header's dismiss button is named "Close <drawer title>".
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).toBeHidden();
  });

  test('the provider is assigned the service they deliver', async () => {
    await navigateTo('Staff');
    await page.getByRole('button', { name: `Services for ${names.staffDisplayName}` }).click();

    const drawer = openDrawer(`${names.staffDisplayName} — services`);
    await drawer.getByRole('checkbox', { name: names.service }).check();
    await drawer.getByRole('button', { name: 'Save services' }).click();

    await expect(page.getByText('Services updated')).toBeVisible();
    await expect(drawer).toBeHidden();
  });

  test('a bookable resource is added', async () => {
    await navigateTo('Resources');
    await page.getByRole('button', { name: 'Add resource' }).first().click();

    const drawer = openDrawer('Add a resource');
    await drawer.getByLabel('Name').fill(names.resource);
    await drawer.getByLabel('Type').selectOption({ label: 'Room' });
    await drawer.getByLabel('Location').selectOption({ label: names.location });
    await drawer.getByLabel(/^Capacity/).fill('1');
    await drawer.getByRole('button', { name: 'Add resource' }).click();

    await expect(drawer).toBeHidden();
    const row = page
      .getByRole('table', { name: 'Bookable resources' })
      .getByRole('row', { name: new RegExp(names.resource, 'i') });
    await expect(row).toBeVisible();
    await expect(row).toContainText(names.location);
  });

  test('a booking link is published for the service', async () => {
    await navigateTo('Booking links');
    await page.getByRole('button', { name: 'Create link' }).first().click();

    const drawer = openDrawer('Create a booking link');
    await drawer.getByLabel('Name').fill(names.bookingLink);
    await drawer.getByLabel('Slug').fill(names.bookingSlug);
    await drawer.getByLabel('Type').selectOption({ label: 'One service' });
    // The service field only exists once the type demands a target.
    await drawer.getByLabel('Service').selectOption({ label: names.service });
    await drawer.getByRole('button', { name: 'Create link' }).click();

    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { name: names.bookingLink })).toBeVisible();
    // Live from the moment it is created — an inactive link 404s publicly.
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
  });

  test('the published link takes a customer to a page offering real times', async ({ browser }) => {
    // A clean context: a customer following the link has no session, and a page
    // that only worked while signed in would be broken for every real visitor.
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();

    await customerPage.goto(`/b/${names.bookingSlug}`);

    // The business's own identity, not MeetFlow's.
    await expect(customerPage.getByText(names.workspace).first()).toBeVisible();
    // A single-service link goes straight to the time step.
    await expect(
      customerPage.getByRole('heading', { level: 1, name: 'Pick a time' }),
    ).toBeVisible();

    // The whole chain — service, provider, hours, assignment, link — resolved
    // into bookable openings. An empty grid here means one of the six steps
    // above did not take effect.
    await expect(slotButtons(customerPage).first()).toBeVisible();
    expect(await slotButtons(customerPage).count()).toBeGreaterThan(0);

    await customerContext.close();
  });

  test('the address the workspace is told to share is the address the link opens at', async () => {
    await navigateTo('Booking links');

    // The card prints `publicUrl` exactly as the API issues it. This is the
    // address an owner copies into an email, so it has to be the address the
    // client router actually serves the booking page from — anything else hands
    // every customer a 404.
    const published = page.getByText(/^https?:\/\/\S+$/);
    await expect(published).toHaveCount(1);

    const publishedUrl = ((await published.textContent()) ?? '').trim();
    expect(new URL(publishedUrl).pathname).toBe(`/b/${names.bookingSlug}`);
  });
});
