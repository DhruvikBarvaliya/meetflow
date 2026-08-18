import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { browserTimezone } from '@/lib/format';
import { CURRENCY_OPTIONS, timezoneOptions } from '@/lib/timezones';
import type { CreateWorkspaceRequest, SlugAvailability } from '@/types/api';
import { AuthLayout } from './AuthLayout';
import { FormBanner } from './FormBanner';
import { useFormApiError } from './useFormApiError';

const SLUG_PATTERN = /^[a-z0-9-]+$/;

const workspaceSchema = z.object({
  name: z.string().trim().min(2, 'Give your workspace a name.').max(120),
  slug: z
    .string()
    .trim()
    .min(2, 'Must be at least 2 characters.')
    .max(60, 'Must be at most 60 characters.')
    .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and hyphens only.'),
  timezone: z.string().min(1, 'Choose a timezone.'),
  currency: z.string().length(3, 'Use a three-letter code.'),
  industry: z.string().trim().max(80).optional(),
  description: z.string().trim().max(2000).optional(),
  websiteUrl: z
    .string()
    .trim()
    .max(300)
    .refine(
      (value) => value === '' || z.string().url().safeParse(value).success,
      'Enter a full URL, including https://',
    ),
  supportEmail: z
    .string()
    .trim()
    .max(254)
    .refine(
      (value) => value === '' || z.string().email().safeParse(value).success,
      'Enter a valid email address.',
    ),
  supportPhone: z.string().trim().max(30),
  createStaffProfile: z.boolean(),
});

type WorkspaceValues = z.infer<typeof workspaceSchema>;

const FIELDS = [
  'name',
  'slug',
  'timezone',
  'currency',
  'industry',
  'description',
  'websiteUrl',
  'supportEmail',
  'supportPhone',
] as const;

/** Mirrors the server's slug rules so the suggestion is always a legal value. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Strips the combining marks NFKD just split off, so "Café" becomes "cafe".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
  );
}

/** Live availability, debounced so a typed name does not fire a call per keystroke. */
function useSlugAvailability(slug: string): {
  state: 'idle' | 'checking' | 'available' | 'taken';
} {
  const [debounced, setDebounced] = useState(slug);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(slug), 400);
    return () => window.clearTimeout(timer);
  }, [slug]);

  const valid = debounced.length >= 2 && debounced.length <= 60 && SLUG_PATTERN.test(debounced);

  const query = useQuery({
    queryKey: ['workspaces', 'slug-available', debounced],
    queryFn: () =>
      api.get<SlugAvailability>('/workspaces/slug-available', { params: { slug: debounced } }),
    enabled: valid,
    staleTime: 30_000,
  });

  if (!valid) return { state: 'idle' };
  // The debounce lags the input; showing "available" for the previous slug
  // while a newer one is still settling would be a lie.
  if (debounced !== slug || query.isPending || query.isFetching) return { state: 'checking' };
  if (query.isError) return { state: 'idle' };
  return { state: query.data?.available === true ? 'available' : 'taken' };
}

export default function CreateWorkspacePage(): JSX.Element {
  const { status, memberships, createWorkspace } = useAuth();
  const navigate = useNavigate();
  const zones = useMemo(() => timezoneOptions(), []);
  const [slugTouched, setSlugTouched] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<WorkspaceValues>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: {
      name: '',
      slug: '',
      timezone: browserTimezone(),
      currency: 'INR',
      industry: '',
      description: '',
      websiteUrl: '',
      supportEmail: '',
      supportPhone: '',
      createStaffProfile: true,
    },
  });

  const { formError, clearFormError, handleApiError } = useFormApiError<WorkspaceValues>(
    setError,
    FIELDS,
  );

  const nameValue = watch('name');
  const slugValue = watch('slug');
  const availability = useSlugAvailability(slugValue);

  useEffect(() => setFocus('name'), [setFocus]);

  // The slug tracks the name until the user edits it themselves, at which point
  // it becomes theirs and is never overwritten.
  useEffect(() => {
    if (slugTouched) return;
    setValue('slug', slugify(nameValue), { shouldValidate: false });
  }, [nameValue, slugTouched, setValue]);

  if (status === 'unauthenticated') return <Navigate to="/login" replace />;

  const onSubmit = handleSubmit(async (values) => {
    clearFormError();

    // Every optional field is omitted rather than sent empty: the create schema
    // is strict() and would reject `websiteUrl: ''` as an invalid URL.
    const payload: CreateWorkspaceRequest = {
      name: values.name,
      timezone: values.timezone,
      slug: values.slug,
      currency: values.currency,
      createStaffProfile: values.createStaffProfile,
      ...(values.industry ? { industry: values.industry } : {}),
      ...(values.description ? { description: values.description } : {}),
      ...(values.websiteUrl ? { websiteUrl: values.websiteUrl } : {}),
      ...(values.supportEmail ? { supportEmail: values.supportEmail } : {}),
      ...(values.supportPhone ? { supportPhone: values.supportPhone } : {}),
    };

    try {
      await createWorkspace(payload);
      navigate('/app', { replace: true });
    } catch (error) {
      handleApiError(error);
    }
  });

  return (
    <AuthLayout
      width="lg"
      title={memberships.length > 0 ? 'Create another workspace' : 'Set up your workspace'}
      description="A workspace holds one business: its services, staff, diary and booking links."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <FormBanner message={formError} />

        <Field label="Workspace name" error={errors.name?.message} required>
          {(fieldProps) => (
            <Input {...fieldProps} {...register('name')} placeholder="Aurora Wellness Studio" />
          )}
        </Field>

        <Field
          label="Workspace address"
          error={errors.slug?.message}
          required
          hint={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono">{slugValue || 'your-workspace'}</span>
              <SlugStatus state={availability.state} />
            </span>
          }
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('slug', { onChange: () => setSlugTouched(true) })}
              placeholder="aurora-wellness-studio"
              spellCheck={false}
              autoCapitalize="none"
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Timezone"
            error={errors.timezone?.message}
            hint="All opening hours and bookings are read in this zone."
            required
          >
            {(fieldProps) => <Select {...fieldProps} {...register('timezone')} options={zones} />}
          </Field>

          <Field label="Currency" error={errors.currency?.message} required>
            {(fieldProps) => (
              <Select {...fieldProps} {...register('currency')} options={[...CURRENCY_OPTIONS]} />
            )}
          </Field>
        </div>

        <Field label="Industry" hint="Optional." error={errors.industry?.message}>
          {(fieldProps) => (
            <Input {...fieldProps} {...register('industry')} placeholder="Health & Wellness" />
          )}
        </Field>

        <Field
          label="Description"
          hint="Optional. Shown on your public booking page."
          error={errors.description?.message}
        >
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              {...register('description')}
              rows={3}
              placeholder="What your business does, in a sentence or two."
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Website" hint="Optional." error={errors.websiteUrl?.message}>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                {...register('websiteUrl')}
                type="url"
                inputMode="url"
                placeholder="https://example.com"
              />
            )}
          </Field>

          <Field label="Support email" hint="Optional." error={errors.supportEmail?.message}>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                {...register('supportEmail')}
                type="email"
                inputMode="email"
                placeholder="hello@example.com"
              />
            )}
          </Field>
        </div>

        <Field label="Support phone" hint="Optional." error={errors.supportPhone?.message}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              {...register('supportPhone')}
              type="tel"
              placeholder="+91 80 4100 0100"
            />
          )}
        </Field>

        <Checkbox
          {...register('createStaffProfile')}
          label="Add me as a bookable staff member"
          description="Creates a staff profile for you so customers can book with you directly. You can change this later."
        />

        <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center">
          {/*
            Not disabled on a taken address: the server appends a suffix rather
            than refusing, so blocking submission would invent a rule the API
            does not have. The hint above says what will happen instead.
          */}
          <Button type="submit" loading={isSubmitting} size="lg" className="sm:min-w-44">
            {isSubmitting ? 'Creating workspace…' : 'Create workspace'}
          </Button>

          {memberships.length > 0 ? (
            <Button variant="ghost" size="lg" onClick={() => navigate('/app')}>
              Cancel
            </Button>
          ) : null}
        </div>

        <p className="mf-sr-only" role="status" aria-live="polite">
          {isSubmitting ? 'Creating your workspace, please wait.' : ''}
        </p>
      </form>
    </AuthLayout>
  );
}

function SlugStatus({
  state,
}: {
  state: 'idle' | 'checking' | 'available' | 'taken';
}): JSX.Element {
  if (state === 'checking') {
    return (
      <span className="inline-flex items-center gap-1 text-fg-muted">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Checking…
      </span>
    );
  }
  if (state === 'available') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-success-text">
        <Check className="size-3" aria-hidden="true" />
        Available
      </span>
    );
  }
  if (state === 'taken') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-warning-text">
        <X className="size-3" aria-hidden="true" />
        Taken — a number will be added
      </span>
    );
  }
  return <span />;
}
