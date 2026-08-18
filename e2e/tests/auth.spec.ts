/**
 * Registration, sign-in, sign-out and the password policy.
 *
 * The sign-out half of the round trip is the part worth being careful about: a
 * "signed out" that only clears the visible UI while leaving a usable token
 * behind looks identical on screen. So the spec does not stop at landing on the
 * login page — it asks for a protected route afterwards and requires to be
 * turned away.
 */
import { expect, test } from '@playwright/test';
import { TEST_PASSWORD, uniqueEmail, uniqueName, uniqueSlug } from '../fixtures/api';
import {
  createWorkspaceThroughUi,
  registerThroughUi,
  signInAsOwner,
  signInThroughUi,
  signOutThroughUi,
} from '../fixtures/ui';

test.describe('authentication', () => {
  test('a new user registers, is taken through onboarding, signs out and signs back in', async ({
    page,
  }) => {
    const user = await registerThroughUi(page);

    // Onboarding, not the dashboard: the account exists but owns nothing yet.
    await expect(page.getByRole('heading', { name: /set up your workspace/i })).toBeVisible();

    const workspace = await createWorkspaceThroughUi(page, {
      name: uniqueName('Auth Studio'),
      slug: uniqueSlug('auth'),
    });
    // The shell names the workspace that was just created, which is how the
    // session and the new membership are shown to have been reconciled.
    await expect(page.getByText(workspace.name).first()).toBeVisible();

    await signOutThroughUi(page);

    // The session is genuinely gone, not merely hidden: a protected route must
    // now bounce back to the login page rather than render.
    await page.goto('/app/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: /sign in to meetflow/i })).toBeVisible();

    await signInAsOwner(page, user.email, user.password);
    // Signing back in returns the same workspace, not a fresh onboarding.
    await expect(page.getByText(workspace.name).first()).toBeVisible();
  });

  test('wrong credentials are refused without revealing which part was wrong', async ({ page }) => {
    // A real account, so the two attempts below differ in exactly one way: one
    // names an address that exists, the other does not.
    const user = await registerThroughUi(page);
    await createWorkspaceThroughUi(page, { slug: uniqueSlug('probe') });
    await signOutThroughUi(page);

    await signInThroughUi(page, user.email, 'NotTheP4ssword!');
    const wrongPassword = page.getByRole('alert');
    await expect(wrongPassword).toBeVisible();
    const wrongPasswordMessage = ((await wrongPassword.textContent()) ?? '').trim();
    await expect(page).toHaveURL(/\/login$/);

    await signInThroughUi(page, uniqueEmail('nobody'), 'NotTheP4ssword!');
    const unknownAccount = page.getByRole('alert');
    await expect(unknownAccount).toBeVisible();
    const unknownAccountMessage = ((await unknownAccount.textContent()) ?? '').trim();

    // The whole point of the rule: the two failures are indistinguishable, so
    // the form cannot be used to enumerate which addresses have accounts.
    expect(wrongPasswordMessage).toBe(unknownAccountMessage);
    expect(wrongPasswordMessage).toMatch(/incorrect email address or password/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the password policy is enforced in the browser before a request is made', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByLabel('First name').fill('Weak');
    await page.getByLabel('Last name').fill('Password');
    await page.getByLabel('Email address').fill(uniqueEmail('weak'));
    await page.getByLabel(/^Password/).fill('short');
    await page.getByLabel('Confirm password').fill('short');
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/register$/);
    // The field's own error, not the always-present checklist item: the
    // checklist reads "At least 10 characters" and would make a laxer assertion
    // pass whether or not the form actually refused anything.
    await expect(page.getByText('Must be at least 10 characters.')).toBeVisible();

    // Long enough and mixed case, but no digit.
    await page.getByLabel(/^Password/).fill('LongEnoughPass');
    await page.getByLabel('Confirm password').fill('LongEnoughPass');
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByText('Must contain a number.')).toBeVisible();
  });

  test('a breached password passes the browser rules and is still refused by the server', async ({
    page,
  }) => {
    // "Changeme123" satisfies every rule the client knows about — ten
    // characters, an uppercase, a lowercase and a digit — but the server also
    // checks a breach list the browser cannot see. This is the case that proves
    // the client-side rules are feedback rather than the actual gate.
    const breached = 'Changeme123';

    await page.goto('/register');
    await page.getByLabel('First name').fill('Breached');
    await page.getByLabel('Last name').fill('Password');
    await page.getByLabel('Email address').fill(uniqueEmail('breached'));
    await page.getByLabel(/^Password/).fill(breached);
    await page.getByLabel('Confirm password').fill(breached);

    // Every browser-side rule is satisfied, so nothing here is refused locally.
    await expect(page.getByText('Must be at least 10 characters.')).toHaveCount(0);
    await expect(page.getByText('Must contain a number.')).toHaveCount(0);

    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/register$/);
    // The server's reason is put on the password field rather than reduced to a
    // generic "check your details", so the user is told what to change.
    await expect(page.getByText(/breach lists/i)).toBeVisible();
  });

  test('an unauthenticated visitor cannot reach the management app', async ({ page }) => {
    await page.goto('/app/appointments');
    await expect(page).toHaveURL(/\/login$/);

    // Signing in then returns them to the page they originally asked for.
    const user = await registerThroughUi(page);
    await createWorkspaceThroughUi(page, { slug: uniqueSlug('deep') });
    await signOutThroughUi(page);

    await page.goto('/app/appointments');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email address').fill(user.email);
    await page.getByLabel(/^Password/).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/app\/appointments$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible();
  });
});
