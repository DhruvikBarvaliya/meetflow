/**
 * The customer-facing manage page.
 *
 * Reached with nothing but the opaque `apt_…` handle, which behaves like a
 * bearer token — so these specs also stand as a check that the page works for
 * someone who has never seen the booking flow.
 *
 * Both sides of the change deadline are covered: the action working when policy
 * allows it, and the page explaining itself when policy does not. The refusing
 * case sets the deadline explicitly rather than relying on a booking's distance
 * from now — the slot search starts from tomorrow, so "tomorrow morning is
 * inside a 24-hour window" is true in the evening and false at breakfast, and
 * the assertion used to flip with the clock.
 *
 * Availability is published per booking link and an appointment does not carry
 * the slug it was booked through, so the page can only show a real slot grid
 * when the slug arrives as `?link=`. The bare-handle fallback is covered too.
 */
import { expect, test } from '@playwright/test';
import {
  bookPublicSlot,
  DEADLINE_COVERS_EVERYTHING,
  createBookableWorkspace,
  fetchPublicSlots,
  uniqueEmail,
  type OwnerFixture,
  setChangeDeadlines,
} from '../fixtures/api';

let workspace: OwnerFixture;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('manage');
});

/**
 * Books an opening at least `minHoursAhead` out and returns its public handle.
 * `nth` walks further down the list so concurrent specs do not contend.
 */
async function bookOne(minHoursAhead: number, nth = 0): Promise<string> {
  const slots = await fetchPublicSlots(workspace.bookingSlug, workspace.serviceId);
  const cutoff = Date.now() + minHoursAhead * 3_600_000;
  const eligible = slots.filter((slot) => new Date(slot.startsAt).getTime() > cutoff);
  expect(eligible.length).toBeGreaterThan(nth);

  const slot = eligible[nth]!;
  const booking = await bookPublicSlot(
    workspace.bookingSlug,
    {
      serviceId: workspace.serviceId,
      staffProfileId: slot.staffProfileId,
      startsAt: slot.startsAt,
      timezone: 'Asia/Kolkata',
      customer: { firstName: 'Manage', lastName: 'Case', email: uniqueEmail('manage') },
    },
    crypto.randomUUID(),
  );
  return booking.appointment.publicId;
}

test('the customer reschedules from the slot grid when the link is known', async ({ page }) => {
  const publicId = await bookOne(48);

  await page.goto(`/appointments/${publicId}?link=${workspace.bookingSlug}`);
  await expect(page.getByRole('heading', { name: /your appointment/i })).toBeVisible();

  const originalWhen = await page.getByRole('definition').first().textContent();

  await page.getByRole('button', { name: /reschedule/i }).click();

  // The slug was supplied, so real openings are offered rather than a bare
  // date-and-time box.
  const slot = page.getByRole('button', { name: /^\d{1,2}:\d{2}/ }).last();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  await slot.click();
  await page.getByRole('button', { name: /move appointment/i }).click();

  await expect(page.getByText(/appointment has been moved/i)).toBeVisible({ timeout: 20_000 });

  const movedWhen = await page.getByRole('definition').first().textContent();
  expect(movedWhen).not.toBe(originalWhen);
});

test('without the link, the customer names a date and time instead', async ({ page }) => {
  const publicId = await bookOne(48, 1);

  // No `?link=`, and a fresh browser profile has nothing remembered.
  await page.goto(`/appointments/${publicId}`);
  await page.getByRole('button', { name: /reschedule/i }).click();

  await expect(page.getByLabel(/new date/i)).toBeVisible();
  await expect(page.getByLabel(/new time/i)).toBeVisible();
  // Nothing chosen yet, so there is nothing to submit.
  await expect(page.getByRole('button', { name: /move appointment/i })).toBeDisabled();
});

test('a booking inside the deadline says why it cannot be moved', async ({ page }) => {
  /*
   * Set, not assumed. The slot search starts from tomorrow, so "the first
   * opening" is inside a 24-hour deadline only when the test happens to run
   * late enough in the day — this assertion inverted itself overnight once
   * already. Widening the deadline past any opening the search can return puts
   * the booking inside the window by construction.
   *
   * Restored afterwards: this file shares one workspace across its tests, and
   * the ones below deliberately expect a change to be *allowed*.
   */
  await setChangeDeadlines(workspace, {
    reschedule: DEADLINE_COVERS_EVERYTHING,
    cancellation: DEADLINE_COVERS_EVERYTHING,
  });

  try {
    const publicId = await bookOne(0);

    await page.goto(`/appointments/${publicId}`);
    await expect(page.getByRole('button', { name: /reschedule/i })).toBeDisabled();

    // A disabled control with no explanation is a dead end, so the rule is
    // named. Which deadline it names is the server suite's business.
    await expect(page.getByText(/only be moved online more than .+ in advance/i)).toBeVisible();
  } finally {
    await setChangeDeadlines(workspace, { reschedule: 1440, cancellation: 1440 });
  }
});

test('the customer cancels, and the page reflects it', async ({ page }) => {
  const publicId = await bookOne(48, 2);

  await page.goto(`/appointments/${publicId}`);
  await page.getByRole('button', { name: /^cancel$/i }).click();

  // Destructive actions go through a confirmation dialog.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/reason/i).fill('Something came up');
  await dialog.getByRole('button', { name: /cancel appointment/i }).click();

  await expect(page.getByText(/appointment has been cancelled/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/this appointment was cancelled/i)).toBeVisible();
  // The actions are gone once there is nothing left to act on.
  await expect(page.getByRole('button', { name: /reschedule/i })).toHaveCount(0);
});

test('changing the timezone re-renders the appointment in the chosen zone', async ({ page }) => {
  const publicId = await bookOne(48, 3);

  await page.goto(`/appointments/${publicId}`);
  const kolkata = await page.getByRole('definition').first().textContent();

  await page.getByLabel(/time zone/i).selectOption('Pacific/Auckland');

  const auckland = await page.getByRole('definition').first().textContent();
  expect(auckland).not.toBe(kolkata);
  // The zone in force is named in the footer, not left for the reader to guess.
  await expect(page.getByRole('contentinfo')).toContainText(/Auckland/i);
});
