/**
 * Rewriting the messages a workspace sends, through the browser.
 *
 * The integration suite already proves the endpoint: that an override reaches
 * the outbox, that a placeholder the message cannot fill is refused, that
 * resetting restores MeetFlow's living copy. What only a browser can prove is
 * that the operator is ever told any of it.
 *
 * That is the failure this file exists for. The 422 the server returns names
 * the offending placeholder and lists the alternatives, and all of that is
 * worthless if the page catches the error and renders "Something went wrong" —
 * which is the default behaviour of almost every mutation handler ever written,
 * costs nothing to introduce, and cannot be detected from the server side at
 * all. The refusal is only useful at the point somebody reads it.
 */
import { expect, test, type Page } from '@playwright/test';
import { apiCall, createBookableWorkspace, type OwnerFixture } from '../fixtures/api';
import { signInAsOwner } from '../fixtures/ui';

let workspace: OwnerFixture;

test.beforeAll(async () => {
  workspace = await createBookableWorkspace('messages');
});

/**
 * The two editor controls, addressed exactly.
 *
 * `exact` is load-bearing, not tidiness. `getByLabel` matches on a substring by
 * default, and the account menu in the header carries an aria-label containing
 * the signed-in address — which for this file's fixture is
 * `messages-…@meetflow.test`. A loose "Message" therefore resolves to the
 * avatar button as well as the textarea, and every test in the file dies on a
 * strict-mode violation that reads nothing like the locator being wrong.
 */
const messageBody = (page: Page) => page.getByLabel('Message', { exact: true });
const subjectLine = (page: Page) => page.getByLabel('Subject line', { exact: true });

/** Opens the editor for one message by its title in the list. */
async function openMessage(page: Page, title: string): Promise<void> {
  await page.goto('/app/messages');
  await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
  await page.getByRole('button', { name: title, exact: false }).first().click();
  await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
}

test.describe('message templates', () => {
  test('an owner sees what is being sent before they have written anything', async ({ page }) => {
    await signInAsOwner(page, workspace.email, workspace.password);
    await page.goto('/app/messages');

    // The list is the catalogue, not the override rows — a workspace that has
    // never edited a message must still see what goes out in its name, which is
    // exactly the visit where a table-driven list would be blank.
    await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Booking confirmed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Appointment reminder/ })).toBeVisible();

    await openMessage(page, 'Booking confirmed');
    // Following MeetFlow's copy, and the page says which — the distinction the
    // screen exists to show, because one of the two keeps improving.
    await expect(page.getByText(/Following MeetFlow’s default/)).toBeVisible();
    await expect(messageBody(page)).not.toHaveValue('');
  });

  test('a placeholder the message cannot fill is refused, in words', async ({ page }) => {
    await signInAsOwner(page, workspace.email, workspace.password);
    await openMessage(page, 'Booking confirmed');

    const body = messageBody(page);
    await body.fill('Hi {{cusotmerName}}, see you then.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Not "Something went wrong". The whole value of the check is that the
    // operator can see which name is wrong and what they could have written
    // instead, so both halves are asserted.
    const refusal = page.getByText(/\{\{cusotmerName\}\}/);
    await expect(refusal).toBeVisible();
    await expect(page.getByText(/\{\{customerName\}\}/).first()).toBeVisible();

    // And nothing was saved: the message still follows the default.
    await page.reload();
    await expect(page.getByText(/Following MeetFlow’s default/)).toBeVisible();
  });

  test('a saved message is the one a customer receives', async ({ page }) => {
    await signInAsOwner(page, workspace.email, workspace.password);
    await openMessage(page, 'Booking confirmed');

    const marker = `Riverside says hello ${Date.now()}`;
    await subjectLine(page).fill('You are booked in at {{businessName}}');
    await messageBody(page).fill(`${marker} — {{customerName}}, see you at {{startsAtLocal}}.`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('New messages will use your copy.')).toBeVisible();
    // The badge is how an operator tells at a glance which messages they have
    // taken ownership of, so it is asserted rather than only the toast.
    await expect(page.getByText(/Your copy, in use/)).toBeVisible();

    // Read it back through the API, which is what a customer's email is built
    // from. Asserting only the screen would prove the form remembers its own
    // input.
    const template = await apiCall<{ bodyText: string; source: string }>(
      '/api/v1/notification-templates/BOOKING_CONFIRMATION/EMAIL',
      { token: workspace.token, businessId: workspace.businessId },
    );
    expect(template.source).toBe('WORKSPACE');
    expect(template.bodyText).toContain(marker);
  });

  test('a draft can be read the way a recipient will read it', async ({ page }) => {
    await signInAsOwner(page, workspace.email, workspace.password);
    await openMessage(page, 'Appointment reminder');

    await messageBody(page).fill('Reminder: {{serviceName}} with {{staffName}}.');
    await page.getByRole('button', { name: 'Preview' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The whole rendered sentence, not a substring of it. The dialog previews
    // the subject line as well as the body, and this message's subject also
    // quotes `{{serviceName}}` — so matching on the sample value alone finds
    // two elements and proves neither of them is the body.
    await expect(
      dialog.getByText('Reminder: Physiotherapy consultation with Dr Anjali Rao.'),
    ).toBeVisible();
    // Rendered, not echoed: no placeholder survives into what a recipient reads.
    await expect(dialog.getByText(/\{\{/)).toHaveCount(0);
  });

  test('restoring gives the message back to MeetFlow', async ({ page }) => {
    await signInAsOwner(page, workspace.email, workspace.password);
    await openMessage(page, 'Booking cancelled');

    await subjectLine(page).fill('We have cancelled your booking');
    await messageBody(page).fill('Sorry {{customerName}} — {{reason}}');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Your copy, in use/)).toBeVisible();

    await page.getByRole('button', { name: /Restore MeetFlow/ }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    // The wording matters: restoring is not pasting the original text back, it
    // is handing the message to a default that keeps changing. The dialog says
    // so, and this asserts that it does.
    await expect(confirm.getByText(/including any later improvements/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Restore', exact: true }).click();

    await expect(page.getByText(/Following MeetFlow’s default/)).toBeVisible();

    const template = await apiCall<{ source: string }>(
      '/api/v1/notification-templates/BOOKING_CANCELLED/EMAIL',
      { token: workspace.token, businessId: workspace.businessId },
    );
    expect(template.source).toBe('BUILT_IN');
  });
});
