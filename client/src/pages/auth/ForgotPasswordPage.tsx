/**
 * Starting a password reset.
 *
 * `POST /auth/password-reset/request` has existed on the server since the first
 * release and had no client code at all, which meant a person who forgot their
 * password could not recover it without someone editing the database for them.
 * This page is the missing half.
 *
 * **The security posture, and why the page is shaped the way it is.** The
 * endpoint answers the same 200 and the same sentence whether or not the
 * address belongs to an account — deliberately, because an endpoint that
 * answered differently would be a free account-existence oracle, and knowing
 * which addresses are real is the first half of a credential-stuffing run. That
 * guarantee is only worth anything if the client keeps it, so this page renders
 * one confirmation panel for every address that clears format validation, with
 * wording that does not claim an email was sent to anybody in particular. There
 * is deliberately no "we could not find that account" branch to write, and none
 * should ever be added here — the server does not supply the fact, and
 * reconstructing it from a timing difference or a status code is exactly the
 * leak the server is avoiding.
 *
 * The failures that *are* surfaced are the ones that say nothing about the
 * address: a malformed email (422 on the field) and a throttled or unreachable
 * API. Those vary with the request, never with who owns the mailbox.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Mail, MailCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { api } from '@/lib/apiClient';
import { AuthLayout } from './AuthLayout';
import { FormBanner } from './FormBanner';
import { emailSchema } from './passwordSchema';
import { useFormApiError } from './useFormApiError';

const forgotPasswordSchema = z.object({ email: emailSchema });

type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

const FIELDS = ['email'] as const;

/**
 * How long a reset token stays usable, from `requestPasswordReset` in
 * server/src/modules/auth/auth.service.ts. Stated because the alternative is a
 * person opening yesterday's email and reading "invalid link" as "my account is
 * gone".
 */
const TOKEN_LIFETIME = 'one hour';

export default function ForgotPasswordPage(): JSX.Element {
  /** The address the confirmation refers to — echoed, never confirmed as real. */
  const [submittedTo, setSubmittedTo] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const { formError, clearFormError, handleApiError } = useFormApiError<ForgotPasswordValues>(
    setError,
    FIELDS,
  );

  useEffect(() => {
    if (submittedTo === null) setFocus('email');
  }, [setFocus, submittedTo]);

  const onSubmit = handleSubmit(async (values) => {
    clearFormError();
    try {
      // `anonymous`: this is a pre-session endpoint, and a visitor arriving here
      // may be carrying an expired token from a previous sign-in. Sending it
      // would put the request through the 401 refresh path for no reason, and a
      // failed refresh clears the session mid-recovery.
      await api.post('/auth/password-reset/request', { email: values.email }, { anonymous: true });
      setSubmittedTo(values.email);
    } catch (error) {
      handleApiError(error);
    }
  });

  if (submittedTo !== null) {
    return (
      <AuthLayout
        title="Check your email"
        description="If we can reach you, the next step is in your inbox."
        footer={
          <Link
            to="/login"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-4" role="status">
          <span
            className="flex size-10 items-center justify-center rounded-full bg-brand-subtle text-brand-text"
            aria-hidden="true"
          >
            <MailCheck className="size-5" />
          </span>

          {/*
            The wording is careful on purpose. "We have sent you an email" would
            be a claim the page cannot make — it does not know whether the
            address has an account, and saying so either way is the leak this
            whole flow avoids. "If … has an account" is both honest and useless
            to somebody probing for live addresses.
          */}
          <p className="text-sm leading-relaxed text-fg">
            If <span className="font-medium">{submittedTo}</span> has a MeetFlow account, a link to
            set a new password is on its way to it. The link works once and expires after{' '}
            {TOKEN_LIFETIME}.
          </p>

          <p className="text-sm leading-relaxed text-fg-muted">
            Nothing arrived? Check the spam folder, then try again — an address with no account will
            never receive anything, which is why this page cannot tell you which it is.
          </p>

          <Button
            variant="secondary"
            fullWidth
            onClick={() => setSubmittedTo(null)}
            leadingIcon={<ArrowLeft className="size-4" aria-hidden="true" />}
          >
            Try a different address
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Tell us the address you sign in with and we will send you a link to set a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link
            to="/login"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormBanner message={formError} />

        <Field label="Email address" error={errors.email?.message} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('email')}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              leadingIcon={<Mail className="size-4" aria-hidden="true" />}
            />
          )}
        </Field>

        <Button type="submit" loading={isSubmitting} fullWidth size="lg" className="mt-1">
          {isSubmitting ? 'Sending the link…' : 'Send the reset link'}
        </Button>

        {/* Announces the pending state to assistive tech, which cannot see the spinner. */}
        <p className="mf-sr-only" role="status" aria-live="polite">
          {isSubmitting ? 'Sending the reset link, please wait.' : ''}
        </p>
      </form>
    </AuthLayout>
  );
}
