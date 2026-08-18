/**
 * Booking links that are *not* the default shape.
 *
 * The happy path in booking.spec.ts runs against a link that permits a provider
 * choice and asks no questions, which leaves two real behaviours untested:
 *
 *  - A link with `allowStaffSelection: false` answers 422 to a `staffProfileId`
 *    ("This booking page assigns the provider for you"). A client that sends
 *    the slot's provider unconditionally makes such links unbookable outright,
 *    and no test against the default link would notice.
 *  - Custom questions are type-checked per question server-side: NUMBER must
 *    arrive as a JSON number and CHECKBOX as a boolean, not as the strings an
 *    `<input>` yields.
 */
import { expect, test } from '@playwright/test';
import { apiCall, createBookableWorkspace, uniqueEmail, type OwnerFixture } from '../fixtures/api';

let workspace: OwnerFixture;
let assignedSlug: string;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('variants');
  const ctx = { token: workspace.token, businessId: workspace.businessId };

  const link = await apiCall<{ slug: string }>('/api/v1/booking-links', {
    ...ctx,
    method: 'POST',
    body: {
      name: 'Assigned provider',
      type: 'SINGLE_SERVICE',
      serviceId: workspace.serviceId,
      // The whole point of this fixture: the customer may not name a provider.
      allowStaffSelection: false,
      customQuestions: [
        {
          key: 'experience',
          label: 'Experience level',
          type: 'SELECT',
          required: true,
          options: ['Beginner', 'Intermediate'],
        },
        { key: 'guests', label: 'Extra guests', type: 'NUMBER', required: false },
        { key: 'waiver', label: 'I accept the waiver', type: 'CHECKBOX', required: true },
      ],
    },
  });

  assignedSlug = link.slug;
});

test('a link that assigns the provider is bookable, and answers keep their JSON types', async ({
  page,
}) => {
  const customerEmail = uniqueEmail('assigned');

  await page.goto(`/b/${assignedSlug}`);

  await expect(page.getByRole('heading', { level: 1, name: /pick a time/i })).toBeVisible({
    timeout: 20_000,
  });

  // No provider step at all: the link publishes no choice to make.
  await expect(page.getByRole('heading', { name: /where and who/i })).toHaveCount(0);

  const slot = page.getByRole('button', { name: /^\d{1,2}:\d{2}/ }).first();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  await slot.click();

  await expect(page.getByRole('heading', { level: 1, name: /your details/i })).toBeVisible();
  await page.getByLabel('First name').fill('Nisha');
  await page.getByLabel('Email').first().fill(customerEmail);

  // The link's own questions, as real controls.
  await page.getByLabel(/experience level/i).selectOption('Intermediate');
  await page.getByLabel(/extra guests/i).fill('2');
  await page.getByRole('checkbox', { name: /accept the waiver/i }).check();
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(page.getByRole('heading', { level: 1, name: /before you book/i })).toBeVisible();
  await page.getByRole('checkbox', { name: /booking policy/i }).check();
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(page.getByRole('heading', { name: /review and confirm/i })).toBeVisible();
  await page.getByRole('button', { name: /confirm booking/i }).click();

  // A 422 from an unwanted staffProfileId would stop the flow dead here.
  await expect(page.getByRole('heading', { name: /you are booked/i })).toBeVisible({
    timeout: 20_000,
  });

  // The success page shows the reference the customer would quote on the phone.
  const reference = await page.getByText(/^apt_[0-9A-HJKMNP-TV-Z]{26}$/).textContent();
  expect(reference).toBeTruthy();

  // The answers survived with the types the server demands — which is why the
  // booking was accepted at all. The list endpoint omits `answers` by design,
  // so they are read back from the customer-facing view that does carry them.
  const stored = await apiCall<{ answers: Record<string, unknown> }>(
    `/api/v1/public/appointments/${reference!.trim()}`,
  );
  expect(stored.answers.experience).toBe('Intermediate');
  expect(stored.answers.guests).toBe(2);
  expect(stored.answers.waiver).toBe(true);
});

test('a required question blocks the step until it is answered', async ({ page }) => {
  await page.goto(`/b/${assignedSlug}`);

  const slot = page.getByRole('button', { name: /^\d{1,2}:\d{2}/ }).first();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  await slot.click();

  await page.getByLabel('First name').fill('Blocked');
  await page.getByLabel('Email').first().fill(uniqueEmail('blocked'));
  await page.getByRole('button', { name: /continue/i }).click();

  // Still on the details step, with the unanswered question called out.
  await expect(page.getByRole('heading', { level: 1, name: /your details/i })).toBeVisible();
  await expect(page.getByText(/experience level is required/i)).toBeVisible();
});
