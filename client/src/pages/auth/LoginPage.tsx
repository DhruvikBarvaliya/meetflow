import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/context/AuthContext';
import { AuthLayout } from './AuthLayout';
import { FormBanner } from './FormBanner';
import { emailSchema } from './passwordSchema';
import { useFormApiError } from './useFormApiError';

const loginSchema = z.object({
  email: emailSchema,
  // Deliberately not the full policy: an existing account may pre-date a rule
  // change, and refusing to even submit would lock that person out.
  password: z.string().min(1, 'Enter your password.'),
});

type LoginValues = z.infer<typeof loginSchema>;

const FIELDS = ['email', 'password'] as const;

interface LocationState {
  from?: string;
}

export default function LoginPage(): JSX.Element {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const { formError, clearFormError, handleApiError } = useFormApiError<LoginValues>(
    setError,
    FIELDS,
  );

  useEffect(() => setFocus('email'), [setFocus]);

  // Someone who is already signed in has no business on this page; going
  // straight through avoids a confusing flash of the form.
  //
  // `state.from` is honoured here too, not just in the submit handler: the
  // moment `login()` resolves, `status` flips and this branch renders first —
  // so hard-coding `/app` here would silently discard the deep link the visitor
  // was originally sent to the login page from.
  if (status === 'authenticated') {
    const state = location.state as LocationState | null;
    return <Navigate to={state?.from ?? '/app'} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    clearFormError();
    try {
      await login(values);
      const state = location.state as LocationState | null;
      navigate(state?.from ?? '/app', { replace: true });
    } catch (error) {
      handleApiError(error);
    }
  });

  return (
    <AuthLayout
      title="Sign in to MeetFlow"
      description="Manage your diary, your team and your bookings."
      footer={
        <>
          New to MeetFlow?{' '}
          <Link
            to="/register"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Create an account
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

        <Field label="Password" error={errors.password?.message} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('password')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Your password"
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

        {/* Beside the field it belongs to rather than under the submit button:
            somebody who cannot get past this input should not have to fail a
            sign-in first to discover that recovery exists. It sits outside the
            Field so it is a sibling of the input rather than part of the
            description a screen reader reads out with it. */}
        <p className="-mt-1 text-right text-sm">
          <Link
            to="/forgot-password"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Forgot your password?
          </Link>
        </p>

        <Button type="submit" loading={isSubmitting} fullWidth size="lg" className="mt-1">
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>

        {/* Announces the pending state to assistive tech, which cannot see the spinner. */}
        <p className="mf-sr-only" role="status" aria-live="polite">
          {isSubmitting ? 'Signing in, please wait.' : ''}
        </p>
      </form>
    </AuthLayout>
  );
}
