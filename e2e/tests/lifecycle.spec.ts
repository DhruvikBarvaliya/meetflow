/**
 * What happens to a booking after it is made, driven from the customer's side.
 *
 * The manage page is reached with nothing but the opaque `apt_…` handle, which
 * behaves like a bearer token — so these specs double as a check that the page
 * works for someone who has never seen the booking flow and has nothing stored
 * in their browser.
 *
 * Two structural facts shape every test here, and both come from the product
 * rather than from convenience:
 *
 *  - The workspace's default deadline for an online change is 24 hours, so a
 *    booking a spec needs to move or cancel has to be made well beyond it. A
 *    spec that grabbed the first available opening would be intermittently
 *    testing the deadline instead.
 *  - Availability is published per booking link, and an appointment does not
 *    carry the slug it was booked through — so the slot grid only appears when
 *    the slug arrives as `?link=`. Both paths are covered.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  bookAppointment,
  DEADLINE_COVERS_EVERYTHING,
  createBookableWorkspace,
  fetchPublicAppointment,
  fetchPublicSlots,
  type OwnerFixture,
  setChangeDeadlines,
} from '../fixtures/api';
import { findInOwnerDiary, signInAsOwner, slotButtons } from '../fixtures/ui';

/** Comfortably past the 24-hour deadline, so policy permits the change. */
const BEYOND_DEADLINE_HOURS = 48;

let workspace: OwnerFixture;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('lifecycle');
});

/** The "When" value on the manage page: the first `<dd>` in its detail list. */
function whenValue(page: Page) {
  return page.getByRole('definition').first();
}

test.describe('appointment lifecycle', () => {
  test('the customer reschedules, and the owner sees the new time', async ({ browser }) => {
    const { confirmation, slot } = await bookAppointment(workspace, {
      minHoursAhead: BEYOND_DEADLINE_HOURS,
      firstName: 'Moved',
    });
    const reference = confirmation.appointment.publicId;

    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();

    // The slug rides along, which is what the success page's own link does.
    await customerPage.goto(`/appointments/${reference}?link=${workspace.bookingSlug}`);
    await expect(customerPage.getByRole('heading', { name: 'Your appointment' })).toBeVisible();
    await expect(customerPage.getByText('Confirmed')).toBeVisible();

    const originalWhen = ((await whenValue(customerPage).textContent()) ?? '').trim();
    expect(originalWhen.length).toBeGreaterThan(0);

    await customerPage.getByRole('button', { name: 'Reschedule' }).click();

    // Real openings, because the link was known. The last one in the window is
    // far from the current booking, so it cannot accidentally be the same time.
    const replacement = slotButtons(customerPage).last();
    await expect(replacement).toBeVisible();
    const newSlotLabel = ((await replacement.textContent()) ?? '').trim();
    await replacement.click();

    await customerPage.getByRole('button', { name: 'Move appointment' }).click();
    await expect(customerPage.getByText('Your appointment has been moved.')).toBeVisible();

    // The page now shows the new time, not a stale render of the old one.
    await expect(whenValue(customerPage)).not.toHaveText(originalWhen);
    await expect(customerPage.getByText('moved 1 time')).toBeVisible();

    // The server moved the same appointment rather than minting a second one.
    const stored = await fetchPublicAppointment(reference);
    expect(stored.publicId).toBe(reference);
    expect(stored.startsAt).not.toBe(slot.startsAt);
    expect(stored.rescheduleCount).toBe(1);
    expect(stored.status).toBe('RESCHEDULED');

    await customerContext.close();

    // --- The workspace's own view -----------------------------------------
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await signInAsOwner(ownerPage, workspace.email, workspace.password);

    const row = await findInOwnerDiary(ownerPage, reference);
    // The time the customer picked, rendered by the diary in the same clock —
    // both surfaces format an instant as `h:mm a` in Asia/Kolkata.
    await expect(row).toContainText(newSlotLabel);
    await expect(row).toContainText('Rescheduled');

    await ownerContext.close();
  });

  test('the customer cancels, and the owner sees it cancelled', async ({ browser }) => {
    const { confirmation, slot } = await bookAppointment(workspace, {
      minHoursAhead: BEYOND_DEADLINE_HOURS,
      skip: 1,
      firstName: 'Cancelled',
    });
    const reference = confirmation.appointment.publicId;
    const reason = 'Something came up';

    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    await customerPage.goto(`/appointments/${reference}`);

    await customerPage.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Destructive actions go through a confirmation, and the reason is optional.
    const dialog = customerPage.getByRole('dialog', { name: 'Cancel this appointment?' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill(reason);
    await dialog.getByRole('button', { name: 'Cancel appointment' }).click();

    await expect(customerPage.getByText('Your appointment has been cancelled.')).toBeVisible();
    await expect(customerPage.getByText(`Reason: ${reason}`)).toBeVisible();
    // Nothing is left to act on, so the actions are gone rather than disabled.
    await expect(customerPage.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);

    const stored = await fetchPublicAppointment(reference);
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancellationReason).toBe(reason);

    await customerContext.close();

    // A cancellation frees the slot; if it did not, the workspace would have
    // lost the hour without anyone occupying it.
    const slots = await fetchPublicSlots(workspace.bookingSlug, workspace.serviceId);
    expect(slots.map((entry) => entry.startsAt)).toContain(slot.startsAt);

    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await signInAsOwner(ownerPage, workspace.email, workspace.password);

    const row = await findInOwnerDiary(ownerPage, reference);
    await expect(row).toContainText('Cancelled');

    await ownerContext.close();
  });

  test('a booking inside the deadline explains why it cannot be changed', async ({ page }) => {
    /*
     * The deadline is set here rather than assumed.
     *
     * This test used to rely on "the first opening available" falling inside
     * the default 24-hour window. Nothing pinned that: the slot search starts
     * from tomorrow, so before about 09:00 local the first opening is more than
     * 24 hours out and every assertion below inverts. It passed all evening and
     * failed first thing the next morning, which reads exactly like a
     * regression and is not one.
     *
     * Widening the deadline past any opening the search can return makes the
     * clock irrelevant: the booking is inside the window by construction, which
     * is what the original comment claimed and did not deliver.
     *
     * Restored in `finally`: this file shares one workspace across its tests,
     * and the ones after this deliberately expect a change to be allowed.
     */
    await setChangeDeadlines(workspace, {
      reschedule: DEADLINE_COVERS_EVERYTHING,
      cancellation: DEADLINE_COVERS_EVERYTHING,
    });

    try {
      const { confirmation } = await bookAppointment(workspace, { firstName: 'TooLate' });

      await page.goto(`/appointments/${confirmation.appointment.publicId}`);

      await expect(page.getByRole('button', { name: 'Reschedule' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();

      // A disabled control with no explanation is a dead end, so the rule that
      // closed it is named rather than left for the customer to infer. The
      // deadline's own arithmetic is covered by the server suite; what matters
      // here is that the page states a rule rather than simply refusing.
      await expect(page.getByText(/only be moved online more than .+ in advance/i)).toBeVisible();
      await expect(
        page.getByText(/only be cancelled online more than .+ in advance/i),
      ).toBeVisible();
    } finally {
      await setChangeDeadlines(workspace, { reschedule: 1440, cancellation: 1440 });
    }
  });

  test('without the link, the customer names a date and time instead', async ({ page }) => {
    const { confirmation } = await bookAppointment(workspace, {
      minHoursAhead: BEYOND_DEADLINE_HOURS,
      skip: 2,
      firstName: 'NoSlug',
    });

    // No `?link=`, and a fresh profile has nothing remembered — the state a
    // customer opening the link from an email on another device is in.
    await page.goto(`/appointments/${confirmation.appointment.publicId}`);
    await page.getByRole('button', { name: 'Reschedule' }).click();

    await expect(page.getByLabel('New date')).toBeVisible();
    await expect(page.getByLabel('New time')).toBeVisible();
    await expect(slotButtons(page)).toHaveCount(0);
    // Nothing chosen yet, so there is nothing to submit.
    await expect(page.getByRole('button', { name: 'Move appointment' })).toBeDisabled();
  });

  test('a cancelled booking cannot be cancelled or moved a second time', async ({ page }) => {
    const { confirmation } = await bookAppointment(workspace, {
      minHoursAhead: BEYOND_DEADLINE_HOURS,
      skip: 3,
      firstName: 'Twice',
    });
    const reference = confirmation.appointment.publicId;

    await page.goto(`/appointments/${reference}`);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    await dialog.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByText('Your appointment has been cancelled.')).toBeVisible();

    // Reloading with the same handle must not resurrect the controls: the
    // appointment is terminal, and the page is what a customer would revisit.
    await page.reload();
    await expect(page.getByText(/this appointment was cancelled/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  });

  test('changing the time zone re-renders the appointment in the chosen zone', async ({ page }) => {
    const { confirmation } = await bookAppointment(workspace, {
      minHoursAhead: BEYOND_DEADLINE_HOURS,
      skip: 4,
      firstName: 'Zoned',
    });

    await page.goto(`/appointments/${confirmation.appointment.publicId}`);
    const booked = ((await whenValue(page).textContent()) ?? '').trim();
    expect(booked.length).toBeGreaterThan(0);

    // Auckland is far enough from the booking zone that the rendered time has
    // to move even for a booking near the middle of the day.
    await page
      .getByLabel('Time zone for the times shown on this page')
      .selectOption('Pacific/Auckland');

    await expect(whenValue(page)).not.toHaveText(booked);
    // And the zone in force is named, rather than left for the reader to infer
    // from a time that silently changed under them.
    await expect(page.getByRole('contentinfo')).toContainText(/Auckland/i);
  });
});
