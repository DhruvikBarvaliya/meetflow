/**
 * A customer books through the public page, and the workspace sees it.
 *
 * The join between the two halves is the `apt_…` reference the success page
 * prints: the customer is shown it, the owner's diary is searchable by it, and
 * it is minted by the server. Using it rather than a name or a time is what
 * makes "the same booking" a claim this spec can actually check, instead of
 * "some booking exists, and the counts went up".
 */
import { expect, test } from '@playwright/test';
import {
  createBookableWorkspace,
  fetchPublicAppointment,
  listAppointments,
  uniqueEmail,
  type OwnerFixture,
} from '../fixtures/api';
import {
  completePublicBooking,
  findInOwnerDiary,
  signInAsOwner,
  slotButtons,
} from '../fixtures/ui';

let workspace: OwnerFixture;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('booking');
});

test.describe('public booking', () => {
  test('a customer books a slot and the owner finds it in the diary', async ({ browser }) => {
    const customer = {
      firstName: 'Riya',
      lastName: 'Patel',
      email: uniqueEmail('customer'),
    };

    // The customer has no session and never gets one. A separate context keeps
    // it that way even though the owner signs in further down this test.
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();

    const { reference, slotLabel } = await completePublicBooking(customerPage, {
      slug: workspace.bookingSlug,
      customer,
    });

    // Confirmed to the person who booked, at the address they gave.
    await expect(
      customerPage.getByText(`We have emailed the details to ${customer.email}`),
    ).toBeVisible();
    await expect(customerPage.getByText(workspace.serviceName)).toBeVisible();

    // What the customer was shown is what the server actually stored.
    const stored = await fetchPublicAppointment(reference);
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.service?.id).toBe(workspace.serviceId);
    expect(stored.staff?.id).toBe(workspace.staffProfileId);

    await customerContext.close();

    // --- The other side of the transaction --------------------------------
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await signInAsOwner(ownerPage, workspace.email, workspace.password);

    const row = await findInOwnerDiary(ownerPage, reference);
    await expect(row).toContainText(`${customer.firstName} ${customer.lastName}`);
    await expect(row).toContainText(workspace.serviceName);
    await expect(row).toContainText(workspace.staffName);
    await expect(row).toContainText('Confirmed');
    // The same opening, as the customer was shown it. Both pages render in
    // Asia/Kolkata, which the Playwright config pins for exactly this reason.
    await expect(row).toContainText(slotLabel);

    await ownerContext.close();
  });

  test('the booking reaches the workspace exactly once', async ({ browser }) => {
    const before = await listAppointments(workspace);

    const context = await browser.newContext();
    const page = await context.newPage();
    const { reference } = await completePublicBooking(page, {
      slug: workspace.bookingSlug,
      customer: { firstName: 'Once', lastName: 'Only', email: uniqueEmail('once') },
    });
    await context.close();

    const after = await listAppointments(workspace);
    // One booking, one appointment. A page that re-submitted on render, or a
    // client retry that was not idempotent, would show up here as two.
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((appointment) => appointment.publicId === reference)).toHaveLength(1);
  });

  test('the slot a customer takes stops being offered to the next one', async ({ browser }) => {
    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();

    await firstPage.goto(`/b/${workspace.bookingSlug}`);
    await expect(firstPage.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible();
    const taken = ((await slotButtons(firstPage).first().textContent()) ?? '').trim();

    await completePublicBooking(firstPage, {
      slug: workspace.bookingSlug,
      customer: { firstName: 'First', lastName: 'Arrival', email: uniqueEmail('first') },
      slotLabel: taken,
    });
    await firstContext.close();

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`/b/${workspace.bookingSlug}`);
    await expect(secondPage.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible();
    await expect(slotButtons(secondPage).first()).toBeVisible();

    // The service holds one person at a time, so the opening the first customer
    // took must be gone — not merely disabled.
    //
    // Scoped to the *first day's* group: the grid shows a week at a time, and
    // "9:00 am" legitimately exists on every other day. Comparing across the
    // whole window would fail even when the booking worked perfectly.
    const firstDayGroup = secondPage.getByRole('group').first();
    const remaining = (await firstDayGroup.getByRole('button').allTextContents()).map((label) =>
      label.trim(),
    );
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining).not.toContain(taken);

    await secondContext.close();
  });

  test('an unknown reference is not distinguishable from one that is simply not yours', async ({
    page,
  }) => {
    // Well-formed but never minted. A page that answered differently here from
    // the way it answers for a real handle would turn the manage URL into an
    // oracle for guessing other people's bookings.
    await page.goto('/appointments/apt_AAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(page.getByText(/could not find that appointment/i)).toBeVisible();
  });
});
