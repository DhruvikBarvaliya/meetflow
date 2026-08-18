import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Mail } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useAuth } from '@/context/AuthContext';
import { browserTimezone } from '@/lib/format';
import { timezoneOptions } from '@/lib/timezones';
import { AuthLayout } from './AuthLayout';
import { FormBanner } from './FormBanner';
import { PasswordChecklist } from './PasswordChecklist';
import { emailSchema, passwordSchema } from './passwordSchema';
import { useFormApiError } from './useFormApiError';

const registerSchema = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required.').max(100),
    lastName: z.string().trim().min(1, 'Last name is required.').max(100),
    email: emailSchema,
    // The server's phone rule is 5–30 characters when present; an empty string
    // is stripped before the request rather than sent as a too-short value.
    phone: z
      .string()
      .trim()
      .max(30, 'Must be at most 30 characters.')
      .refine((value) => value === '' || value.length >= 5, 'Enter a full phone number.'),
    timezone: z.string().min(1, 'Choose a timezone.'),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your password.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Both passwords must match.',
  });

type RegisterValues = z.infer<typeof registerSchema>;

const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'timezone', 'password'] as const;

export default function RegisterPage(): JSX.Element {
  const { status, register: createAccount } = useAuth();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const zones = useMemo(() => timezoneOptions(), []);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      // Pre-selecting the browser's zone is right far more often than not, and
      // it is the value the API would otherwise default to anyway.
      timezone: browserTimezone(),
      password: '',
      confirmPassword: '',
    },
  });

  const { formError, clearFormError, handleApiError } = useFormApiError<RegisterValues>(
    setError,
    FIELDS,
  );

  const passwordValue = watch('password');

  useEffect(() => setFocus('firstName'), [setFocus]);

  if (status === 'authenticated') return <Navigate to="/app" replace />;

  const onSubmit = handleSubmit(async (values) => {
    clearFormError();
    try {
      await createAccount({
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        password: values.password,
        timezone: values.timezone,
        // The body schema is strict(): sending `phone: ''` would be a 422, so
        // an untouched optional field is omitted entirely.
        ...(values.phone.length > 0 ? { phone: values.phone } : {}),
      });
      // A brand-new account has no workspace yet; that is the only next step.
      navigate('/create-workspace', { replace: true });
    } catch (error) {
      handleApiError(error);
    }
  });

  return (
    <AuthLayout
      title="Create your MeetFlow account"
      description="You will set up your first workspace next."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormBanner message={formError} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" error={errors.firstName?.message} required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                {...register('firstName')}
                autoComplete="given-name"
                placeholder="Priya"
              />
            )}
          </Field>

          <Field label="Last name" error={errors.lastName?.message} required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                {...register('lastName')}
                autoComplete="family-name"
                placeholder="Shah"
              />
            )}
          </Field>
        </div>

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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Phone"
            hint="Optional. Used for booking notifications."
            error={errors.phone?.message}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                {...register('phone')}
                type="tel"
                autoComplete="tel"
                placeholder="+91 98450 00000"
              />
            )}
          </Field>

          <Field label="Your timezone" error={errors.timezone?.message} required>
            {(fieldProps) => <Select {...fieldProps} {...register('timezone')} options={zones} />}
          </Field>
        </div>

        <Field
          label="Password"
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

        <Field label="Confirm password" error={errors.confirmPassword?.message} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('confirmPassword')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
            />
          )}
        </Field>

        <Button type="submit" loading={isSubmitting} fullWidth size="lg" className="mt-1">
          {isSubmitting ? 'Creating your account…' : 'Create account'}
        </Button>

        <p className="mf-sr-only" role="status" aria-live="polite">
          {isSubmitting ? 'Creating your account, please wait.' : ''}
        </p>
      </form>
    </AuthLayout>
  );
}
