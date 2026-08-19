/**
 * Finishing a password reset.
 *
 * The other end of the link `POST /auth/password-reset/request` emails out.
 * `notification.service.ts` builds that link as
 * `${PUBLIC_APP_URL}/reset-password?token=…`, so this page must be mounted at
 * exactly `/reset-password` and must read the token from the query string —
 * change either and every reset email in flight becomes a dead link.
 *
 * Three decisions worth stating.
 *
 * **The token is never displayed and never put in a form field.** It is a
 * bearer credential for one account. Rendering it would put it in screenshots,
 * in the accessibility tree, and in whatever a browser extension can read off
 * the page; it lives in the URL only because an email can carry nothing else.
 *
 * **A successful reset ends the local session.** `resetPassword` revokes every
 * refresh token the account holds, so any tokens this browser is still carrying
 * are already dead. Leaving them in place would mean the app looked signed in
 * until the next request failed for a reason the user could not connect to what
 * they just did.
 *
 * **The live password policy is read, and only used to report drift.** The
 * checklist under the field is a mirror of the server's rules (see
 * passwordSchema.ts), and a mirror can fall behind. If the deployment has since
 * raised the minimum, every rule would tick green on a password the server will
 * refuse, and the person would be stuck retyping with no explanation.
 * `GET /auth/password-policy` is the only way to notice, so the page asks — and
 * says nothing at all until the answer arrives, because a guess about the rules
 * is worse than silence.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Eye, EyeOff, KeyRound, LinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Button, buttonStyles } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import type { PasswordPolicy } from '@/types/api';
import { AuthLayout } from './AuthLayout';
import { FormBanner } from './FormBanner';
import { PasswordChecklist } from './PasswordChecklist';
import { passwordSchema } from './passwordSchema';
import { useFormApiError } from './useFormApiError';

const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Type the new password again.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Both passwords must match.',
  });

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

const FIELDS = ['password'] as const;

/**
 * The minimum `PasswordChecklist` ticks against, restated so the two numbers
 * can be compared.
 *
 * It is not a second source of truth — passwordSchema.ts owns the mirror and
 * this is a copy of one value from it — but it is what makes the drift check
 * below possible at all. If that file's `length` rule changes, change this too.
 */
const CHECKLIST_MIN_LENGTH = 10;

/**
 * What the live policy demands that the checklist is not testing for, in plain
 * words. Empty in the ordinary case, which is why nothing is rendered then.
 */
function policyDrift(policy: PasswordPolicy): string | null {
  return policy.minLength > CHECKLIST_MIN_LENGTH
    ? `This deployment requires at least ${policy.minLength} characters, which is more than the checklist below is testing for.`
    : null;
}

export default function ResetPasswordPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const { status, logout } = useAuth();
  const token = searchParams.get('token') ?? '';

  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const { formError, clearFormError, handleApiError } = useFormApiError<ResetPasswordValues>(
    setError,
    FIELDS,
  );

  // Unauthenticated and cheap, and its answer does not change between visits.
  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () => api.get<PasswordPolicy>('/auth/password-policy', { anonymous: true }),
    staleTime: 60 * 60_000,
    retry: false,
  });

  const passwordValue = watch('password');
  const hasToken = token.length > 0;

  useEffect(() => {
    if (hasToken && !done) setFocus('password');
  }, [setFocus, hasToken, done]);

  const onSubmit = handleSubmit(async (values) => {
    clearFormError();
    try {
      // `anonymous`: the visitor is usually signed out, and any token this
      // browser still holds is about to be revoked anyway. Sending it would
      // only route a failure through the refresh path.
      await api.post(
        '/auth/password-reset/confirm',
        { token, password: values.password },
        { anonymous: true },
      );
      // Every refresh token on the account has just been revoked server-side.
      // Clearing here keeps the UI's idea of the session and the server's the
      // same, instead of leaving a dead one to fail later for a reason the user
      // cannot connect to this.
      if (status === 'authenticated') await logout();
      setDone(true);
    } catch (error) {
      handleApiError(error);
    }
  });

  // --- The link was opened without its token -------------------------------
  //
  // Usually a mail client that wrapped the URL across two lines. Named as the
  // ordinary thing it is, with the one action that fixes it.
  if (!hasToken) {
    return (
      <AuthLayout
        title="This link is incomplete"
        description="The address in the bar is missing the part that identifies your reset request."
      >
        <div className="flex flex-col gap-4">
          <span
            className="flex size-10 items-center justify-center rounded-full bg-warning-subtle text-warning-text"
            aria-hidden="true"
          >
            <LinkIcon className="size-5" />
          </span>
          <p className="text-sm leading-relaxed text-fg">
            This normally happens when an email program breaks a long link across two lines and only
            the first half is opened. Copying the whole link out of the email will work; so will
            asking for a new one.
          </p>
          <Link to="/forgot-password" className={buttonStyles('primary', 'lg')}>
            Send a new reset link
          </Link>
          <Link to="/login" className={buttonStyles('ghost', 'md')}>
            Back to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  // --- Done ----------------------------------------------------------------
  if (done) {
    return (
      <AuthLayout title="Your password has been changed" description="Sign in with the new one.">
        <div className="flex flex-col gap-4" role="status">
          <span
            className="flex size-10 items-center justify-center rounded-full bg-success-subtle text-success-text"
            aria-hidden="true"
          >
            <CheckCircle2 className="size-5" />
          </span>
          <p className="text-sm leading-relaxed text-fg">
            Everything that was signed in to this account has been signed out — this browser, your
            phone, anything you had left open. That is deliberate: if somebody else had got in, they
            are out now.
          </p>
          <Link to="/login" className={buttonStyles('primary', 'lg')}>
            Sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const drift = policyQuery.data ? policyDrift(policyQuery.data) : null;

  return (
    <AuthLayout
      title="Choose a new password"
      description="Pick something you have not used here before."
      footer={
        <>
          Link expired?{' '}
          <Link
            to="/forgot-password"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Ask for a new one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormBanner message={formError} />

        {/* Rendered only once the live policy has arrived and disagrees with the
            mirror. Silence is the honest state while the request is in flight or
            if it failed — the page has nothing to report yet. */}
        {drift ? (
          <p
            role="status"
            className="rounded-md border border-warning-border bg-warning-subtle px-3.5 py-3 text-sm leading-relaxed text-warning-text"
          >
            {drift}
          </p>
        ) : null}

        <Field
          label="New password"
          error={errors.password?.message}
          hint={<PasswordChecklist value={passwordValue} />}
          required
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('password')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              trailingSlot={
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="rounded-md p-1 text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              }
            />
          )}
        </Field>

        <Field label="Repeat the new password" error={errors.confirmPassword?.message} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('confirmPassword')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
            />
          )}
        </Field>

        <Button
          type="submit"
          loading={isSubmitting}
          fullWidth
          size="lg"
          className="mt-1"
          leadingIcon={<KeyRound className="size-4" aria-hidden="true" />}
        >
          {isSubmitting ? 'Saving your new password…' : 'Set new password'}
        </Button>

        <p className="mf-sr-only" role="status" aria-live="polite">
          {isSubmitting ? 'Saving your new password, please wait.' : ''}
        </p>
      </form>
    </AuthLayout>
  );
}
