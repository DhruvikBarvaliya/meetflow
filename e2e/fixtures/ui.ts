/**
 * Browser-side flows, expressed once.
 *
 * These are the journeys more than one spec has to walk through to reach the
 * thing it is actually testing — registering, signing in, and taking a booking
 * through the public page. Each helper asserts that the step it performed
 * genuinely landed, so a spec that fails fails at the point of the real problem
 * rather than three steps later on a selector that was never going to match.
 *
 * Selectors are role- and label-based throughout. That is not a style
 * preference: the labels here are the same ones a screen reader announces, so a
 * change that breaks these specs is a change that broke the page for somebody.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { TEST_PASSWORD, TEST_TIMEZONE, uniqueEmail, uniqueName, uniqueSlug } from './api';
import { verifyEmailFor } from './verification';

/**
 * Slot buttons carry the opening time as their accessible name, formatted
 * `h:mm a` and lowercased — "9:00 am". Anchoring at the start keeps this from
 * matching the date pickers or the window-paging controls.
 */
export const SLOT_NAME = /^\d{1,2}:\d{2}\s*(am|pm)/i;

export function slotButtons(page: Page): Locator {
  return page.getByRole('button', { name: SLOT_NAME });
}

// ---------------------------------------------------------------------------
// Account and session
// ---------------------------------------------------------------------------

export interface RegisteredUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Registers through the form and stops where the product stops: onboarding.
 *
 * A brand-new account has no workspace, so `/create-workspace` — not the
 * dashboard — is the correct landing place, and asserting on it here is what
 * keeps a regression in that redirect from being absorbed by a later step.
 */
export async function registerThroughUi(
  page: Page,
  overrides: Partial<RegisteredUser> = {},
): Promise<RegisteredUser> {
  const user: RegisteredUser = {
    email: overrides.email ?? uniqueEmail('register'),
    password: overrides.password ?? TEST_PASSWORD,
    firstName: overrides.firstName ?? 'Ada',
    lastName: overrides.lastName ?? 'Shah',
  };

  await page.goto('/register');
  await expect(page.getByRole('heading', { name: /create your meetflow account/i })).toBeVisible();

  await page.getByLabel('First name').fill(user.firstName);
  await page.getByLabel('Last name').fill(user.lastName);
  await page.getByLabel('Email address').fill(user.email);
  // Anchored: "Confirm password" would otherwise match the same substring.
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: /create account/i }).click();

  // The product's first stop for a brand-new account is the confirmation
  // screen, not onboarding: `requireVerifiedEmail` guards every authenticated
  // surface, so there is nothing for them to do until the address is confirmed.
  // Asserted rather than skipped past, because a registration that silently
  // dropped somebody straight into onboarding would mean the gate had stopped
  // working and no other spec would notice.
  await expect(page.getByRole('heading', { name: 'Confirm your email address' })).toBeVisible();
  await expect(page.getByText(user.email)).toBeVisible();

  // Then the link, taken out of the outbox — see `fixtures/verification.ts`.
  await verifyEmailFor(user.email);
  await page.reload();

  await expect(page).toHaveURL(/\/create-workspace$/);
  return user;
}

export interface WorkspaceDraft {
  name: string;
  slug: string;
  /** Unchecked leaves the owner without a staff profile, so one can be created on the Staff page. */
  addMeAsStaff: boolean;
}

/**
 * Fills in onboarding and lands in the management app.
 *
 * Timezone and currency are left at their defaults deliberately: the browser is
 * pinned to Asia/Kolkata in the Playwright config and the form pre-selects the
 * browser's own zone, so accepting the default is what a real user does and it
 * keeps the workspace clock aligned with the specs' clock.
 */
export async function createWorkspaceThroughUi(
  page: Page,
  overrides: Partial<WorkspaceDraft> = {},
): Promise<WorkspaceDraft> {
  const draft: WorkspaceDraft = {
    name: overrides.name ?? uniqueName('E2E Studio'),
    slug: overrides.slug ?? uniqueSlug('e2e'),
    addMeAsStaff: overrides.addMeAsStaff ?? true,
  };

  await expect(page).toHaveURL(/\/create-workspace$/);
  await page.getByLabel('Workspace name').fill(draft.name);
  // The address auto-fills from the name; overwriting it makes the slug the
  // spec's own, which is what keeps two runs from contending for one address.
  await page.getByLabel('Workspace address').fill(draft.slug);

  await expect(page.getByLabel('Timezone')).toHaveValue(TEST_TIMEZONE);

  const staffToggle = page.getByRole('checkbox', { name: /bookable staff member/i });
  if (draft.addMeAsStaff) await staffToggle.check();
  else await staffToggle.uncheck();

  await page.getByRole('button', { name: /create workspace/i }).click();

  await expect(page).toHaveURL(/\/app(\/dashboard)?$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  return draft;
}

export async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

/** Signs out through the account menu, the only place the product offers it. */
export async function signOutThroughUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: /account menu for/i }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Signs in and waits for the management shell, for specs that start signed in. */
export async function signInAsOwner(page: Page, email: string, password: string): Promise<void> {
  await signInThroughUi(page, email, password);
  await expect(page).toHaveURL(/\/app(\/dashboard)?$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// The public booking flow
// ---------------------------------------------------------------------------

export interface CustomerDetails {
  firstName: string;
  lastName: string;
  email: string;
}

export interface BookingSelection {
  /** The opening the visitor chose, as the page labelled it — e.g. "9:00 am". */
  slotLabel: string;
}

/**
 * Walks the public page as far as the review step, stopping before Confirm.
 *
 * Split out from `completePublicBooking` so a spec about *racing* can bring two
 * browsers to the brink and then release them together — which is the only way
 * to make two customers genuinely contend for one opening.
 */
export async function fillBookingUpToReview(
  page: Page,
  options: { slug: string; customer: CustomerDetails; slotLabel?: string },
): Promise<BookingSelection> {
  await page.goto(`/b/${options.slug}`);

  // A single-service link has nothing to ask on the first step, so the flow
  // opens on the time picker. Anchored to the h1 because the slot picker's own
  // h2 also reads "Choose a time".
  await expect(page.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible();

  const slot = options.slotLabel
    ? page.getByRole('button', { name: options.slotLabel, exact: true }).first()
    : slotButtons(page).first();

  await expect(slot).toBeVisible();
  const slotLabel = (await slot.textContent())?.trim() ?? '';
  expect(slotLabel).toMatch(SLOT_NAME);
  await slot.click();

  await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible();
  await page.getByLabel('First name').fill(options.customer.firstName);
  await page.getByLabel('Last name').fill(options.customer.lastName);
  await page.getByLabel(/^Email/).fill(options.customer.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Consent is given before anything is reviewed, and the flow refuses to
  // advance without it.
  await expect(page.getByRole('heading', { level: 1, name: 'Before you book' })).toBeVisible();
  await page.getByRole('checkbox', { name: /booking policy/i }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Review and confirm' })).toBeVisible();
  return { slotLabel };
}

/**
 * The whole customer journey, ending on the confirmation.
 *
 * Returns the `apt_…` reference the success page prints — the same handle the
 * customer would quote on the phone, and the one the owner's diary is searched
 * by, so a spec can join the two sides without inventing an identifier.
 */
export async function completePublicBooking(
  page: Page,
  options: { slug: string; customer: CustomerDetails; slotLabel?: string },
): Promise<{ reference: string; slotLabel: string }> {
  const { slotLabel } = await fillBookingUpToReview(page, options);

  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'You are booked' })).toBeVisible();

  const reference = await readBookingReference(page);
  return { reference, slotLabel };
}

/** The opaque handle printed on the success page. */
export async function readBookingReference(page: Page): Promise<string> {
  const reference = page.getByText(/^apt_[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(reference).toBeVisible();
  const value = (await reference.textContent())?.trim() ?? '';
  expect(value).toMatch(/^apt_[0-9A-HJKMNP-TV-Z]{26}$/);
  return value;
}

// ---------------------------------------------------------------------------
// Owner-side reads
// ---------------------------------------------------------------------------

/**
 * Opens the owner's diary, narrowed to one booking by its public reference.
 *
 * Searching rather than paging: the diary is paginated and ordered by date, so
 * a spec that walked pages hunting for its own row would be asserting on the
 * page size as much as on the booking. The reference is opaque and unique, and
 * the server matches it against `publicId`, so exactly one row can come back —
 * which is itself the assertion that the booking reached the workspace.
 *
 * Returns that row, for the caller to make its own assertions about.
 */
export async function findInOwnerDiary(page: Page, reference: string): Promise<Locator> {
  await page.goto('/app/appointments');
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();

  await page.getByLabel('Search').fill(reference);

  const table = page.getByRole('table', { name: 'Appointments' });
  // One header row plus exactly one match. A count of 1 would mean the search
  // found nothing; anything above 2 would mean the reference is not unique.
  await expect(table.getByRole('row')).toHaveCount(2);
  return table.getByRole('row').last();
}
