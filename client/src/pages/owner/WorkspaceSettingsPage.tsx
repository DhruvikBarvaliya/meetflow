import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import { ownerKeys } from '@/components/owner';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { formatDuration } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { CURRENCY_OPTIONS, timezoneOptions } from '@/lib/timezones';
import { FormBanner } from '@/pages/auth/FormBanner';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { BusinessSettings, Workspace } from '@/types/api';

const TIMEZONE_OPTIONS = timezoneOptions();

const nullableUrl = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .refine(
    (value) => value === null || /^https?:\/\/\S+$/.test(value),
    'Enter a full URL including https://.',
  );

const profileSchema = z.object({
  name: z.string().trim().min(2, 'A workspace name is required.').max(120),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => (value === '' ? null : value)),
  industry: z
    .string()
    .trim()
    .max(80)
    .transform((value) => (value === '' ? null : value)),
  timezone: z.string().min(1, 'Choose the clock this workspace keeps.'),
  currency: z.string().length(3, 'Use a three-letter ISO 4217 code.'),
  locale: z.string().trim().max(20),
  websiteUrl: nullableUrl,
  logoUrl: nullableUrl,
  supportEmail: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine(
      (value) => value === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
      'Enter a valid email address.',
    ),
  supportPhone: z
    .string()
    .trim()
    .max(30)
    .transform((value) => (value === '' ? null : value)),
});

type ProfileValues = z.input<typeof profileSchema>;

const PROFILE_FIELDS = [
  'name',
  'description',
  'industry',
  'timezone',
  'currency',
  'locale',
  'websiteUrl',
  'logoUrl',
  'supportEmail',
  'supportPhone',
] as const;

const wholeNumber = (min: number, max: number, message: string) =>
  z.coerce.number().int(message).min(min, message).max(max, message);

const nullableWholeNumber = (min: number, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine((value) => value === null || (Number.isInteger(value) && value >= min), message);

const policySchema = z.object({
  slotIntervalMinutes: wholeNumber(1, 480, 'Use 1–480 minutes.'),
  defaultPreBufferMinutes: wholeNumber(0, 1440, 'Use 0–1440 minutes.'),
  defaultPostBufferMinutes: wholeNumber(0, 1440, 'Use 0–1440 minutes.'),
  minNoticeMinutes: wholeNumber(0, 525_600, 'Use 0 minutes or more.'),
  maxHorizonDays: wholeNumber(1, 730, 'Use 1–730 days.'),
  cancellationDeadlineMinutes: wholeNumber(0, 525_600, 'Use 0 minutes or more.'),
  rescheduleDeadlineMinutes: wholeNumber(0, 525_600, 'Use 0 minutes or more.'),
  maxReschedulesPerAppointment: wholeNumber(0, 50, 'Use 0–50.'),
  noShowGraceMinutes: wholeNumber(0, 1440, 'Use 0–1440 minutes.'),
  waitlistHoldMinutes: wholeNumber(1, 10_080, 'Use 1–10080 minutes.'),
  maxBookingsPerCustomerPerDay: nullableWholeNumber(1, 'Use 1 or more, or leave blank for none.'),
  maxBookingsPerStaffPerDay: nullableWholeNumber(1, 'Use 1 or more, or leave blank for none.'),
  reminderOffsetsMinutes: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isFinite(entry)),
    )
    .refine(
      (offsets) =>
        offsets.length <= 5 && offsets.every((offset) => offset >= 1 && offset <= 43_200),
      'Up to five reminders, each between 1 minute and 30 days before the start.',
    ),
  allowCustomerCancel: z.boolean(),
  allowCustomerReschedule: z.boolean(),
  requireApproval: z.boolean(),
  waitlistEnabled: z.boolean(),
  waitlistAutoBook: z.boolean(),
});

type PolicyValues = z.input<typeof policySchema>;

const POLICY_FIELDS = [
  'slotIntervalMinutes',
  'defaultPreBufferMinutes',
  'defaultPostBufferMinutes',
  'minNoticeMinutes',
  'maxHorizonDays',
  'cancellationDeadlineMinutes',
  'rescheduleDeadlineMinutes',
  'maxReschedulesPerAppointment',
  'noShowGraceMinutes',
  'waitlistHoldMinutes',
  'maxBookingsPerCustomerPerDay',
  'maxBookingsPerStaffPerDay',
  'reminderOffsetsMinutes',
  'allowCustomerCancel',
  'allowCustomerReschedule',
  'requireApproval',
  'waitlistEnabled',
  'waitlistAutoBook',
] as const;

function toPolicyValues(settings: BusinessSettings): PolicyValues {
  return {
    slotIntervalMinutes: settings.slotIntervalMinutes,
    defaultPreBufferMinutes: settings.defaultPreBufferMinutes,
    defaultPostBufferMinutes: settings.defaultPostBufferMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxHorizonDays: settings.maxHorizonDays,
    cancellationDeadlineMinutes: settings.cancellationDeadlineMinutes,
    rescheduleDeadlineMinutes: settings.rescheduleDeadlineMinutes,
    maxReschedulesPerAppointment: settings.maxReschedulesPerAppointment,
    noShowGraceMinutes: settings.noShowGraceMinutes,
    waitlistHoldMinutes: settings.waitlistHoldMinutes,
    maxBookingsPerCustomerPerDay:
      settings.maxBookingsPerCustomerPerDay === null
        ? ''
        : String(settings.maxBookingsPerCustomerPerDay),
    maxBookingsPerStaffPerDay:
      settings.maxBookingsPerStaffPerDay === null ? '' : String(settings.maxBookingsPerStaffPerDay),
    reminderOffsetsMinutes: settings.reminderOffsetsMinutes.join(', '),
    allowCustomerCancel: settings.allowCustomerCancel,
    allowCustomerReschedule: settings.allowCustomerReschedule,
    requireApproval: settings.requireApproval,
    waitlistEnabled: settings.waitlistEnabled,
    waitlistAutoBook: settings.waitlistAutoBook,
  };
}

// ---------------------------------------------------------------------------

function ProfilePanel({ workspace }: { workspace: Workspace }): JSX.Element {
  const { activeBusinessId, can, refreshIdentity } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canEdit = can(PERMISSIONS.WORKSPACE_UPDATE);

  const form = useForm<ProfileValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(profileSchema, undefined, { raw: true }),
    defaultValues: {
      name: workspace.name,
      description: workspace.description ?? '',
      industry: workspace.industry ?? '',
      timezone: workspace.timezone,
      currency: workspace.currency,
      locale: workspace.locale,
      websiteUrl: workspace.websiteUrl ?? '',
      logoUrl: workspace.logoUrl ?? '',
      supportEmail: workspace.supportEmail ?? '',
      supportPhone: workspace.supportPhone ?? '',
    },
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(
    form.setError,
    PROFILE_FIELDS,
  );

  const save = useMutation<Workspace, unknown, z.output<typeof profileSchema>>({
    mutationFn: (payload) => api.patch<Workspace>('/workspace', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ownerKeys.workspace(activeBusinessId) });
      // The workspace name and timezone are carried on the membership the shell
      // renders from, so the identity has to be re-read for the change to show.
      void refreshIdentity();
      toast({ tone: 'success', title: 'Workspace updated' });
    },
    onError: handleApiError,
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => {
        clearFormError();
        save.mutate(profileSchema.parse(values));
      })}
    >
      <Card>
        <CardHeader
          as="h2"
          title="Workspace profile"
          description="What customers see on your booking pages, and the clock everything else is resolved against."
        />
        <CardBody className="flex flex-col gap-4">
          <FormBanner message={formError} />

          <Field label="Name" required error={form.formState.errors.name?.message}>
            {(field) => <Input {...field} {...form.register('name')} disabled={!canEdit} />}
          </Field>

          <Field label="Description" error={form.formState.errors.description?.message}>
            {(field) => (
              <Textarea {...field} {...form.register('description')} rows={3} disabled={!canEdit} />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Industry" error={form.formState.errors.industry?.message}>
              {(field) => <Input {...field} {...form.register('industry')} disabled={!canEdit} />}
            </Field>
            <Field
              label="Public URL slug"
              hint="Set when the workspace was created and fixed thereafter."
            >
              {(field) => <Input {...field} value={workspace.slug} readOnly disabled />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Timezone"
              required
              hint="The clock the diary and every report are kept in."
              error={form.formState.errors.timezone?.message}
            >
              {(field) => (
                <Select
                  {...field}
                  {...form.register('timezone')}
                  options={TIMEZONE_OPTIONS}
                  disabled={!canEdit}
                />
              )}
            </Field>
            <Field
              label="Currency"
              required
              hint="Prices are stored in this currency's smallest unit."
              error={form.formState.errors.currency?.message}
            >
              {(field) => (
                <Select
                  {...field}
                  {...form.register('currency')}
                  options={CURRENCY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  disabled={!canEdit}
                />
              )}
            </Field>
            <Field
              label="Locale"
              hint="BCP 47, e.g. en-IN."
              error={form.formState.errors.locale?.message}
            >
              {(field) => <Input {...field} {...form.register('locale')} disabled={!canEdit} />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Website" error={form.formState.errors.websiteUrl?.message}>
              {(field) => (
                <Input {...field} {...form.register('websiteUrl')} type="url" disabled={!canEdit} />
              )}
            </Field>
            <Field label="Logo URL" error={form.formState.errors.logoUrl?.message}>
              {(field) => (
                <Input {...field} {...form.register('logoUrl')} type="url" disabled={!canEdit} />
              )}
            </Field>
            <Field label="Support email" error={form.formState.errors.supportEmail?.message}>
              {(field) => (
                <Input
                  {...field}
                  {...form.register('supportEmail')}
                  type="email"
                  disabled={!canEdit}
                />
              )}
            </Field>
            <Field label="Support phone" error={form.formState.errors.supportPhone?.message}>
              {(field) => (
                <Input
                  {...field}
                  {...form.register('supportPhone')}
                  type="tel"
                  disabled={!canEdit}
                />
              )}
            </Field>
          </div>
        </CardBody>
        {canEdit ? (
          <CardFooter>
            <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
              Save profile
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}

function PolicyPanel({ settings }: { settings: BusinessSettings }): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canEdit = can(PERMISSIONS.WORKSPACE_SETTINGS_MANAGE);

  const form = useForm<PolicyValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(policySchema, undefined, { raw: true }),
    defaultValues: toPolicyValues(settings),
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(
    form.setError,
    POLICY_FIELDS,
  );

  const save = useMutation<BusinessSettings, unknown, z.output<typeof policySchema>>({
    mutationFn: (payload) => api.patch<BusinessSettings>('/workspace/settings', payload),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({
        queryKey: ownerKeys.workspaceSettings(activeBusinessId),
      });
      void queryClient.invalidateQueries({ queryKey: ownerKeys.workspace(activeBusinessId) });
      form.reset(toPolicyValues(updated));
      toast({ tone: 'success', title: 'Booking policy saved' });
    },
    onError: handleApiError,
  });

  const numberField = (
    name: (typeof POLICY_FIELDS)[number],
    label: string,
    hint: string,
    max?: number,
  ): JSX.Element => (
    <Field label={label} hint={hint} error={form.formState.errors[name]?.message}>
      {(field) => (
        <Input
          {...field}
          {...form.register(name)}
          type="number"
          min={0}
          max={max}
          disabled={!canEdit}
        />
      )}
    </Field>
  );

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => {
        clearFormError();
        save.mutate(policySchema.parse(values));
      })}
      className="flex flex-col gap-6"
    >
      <FormBanner message={formError} />

      <Card>
        <CardHeader
          as="h2"
          title="How slots are offered"
          description="These are the workspace defaults. A service or a staff profile may override any of them."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {numberField(
            'slotIntervalMinutes',
            'Slot interval',
            `Minutes between offered start times. Currently every ${formatDuration(
              settings.slotIntervalMinutes,
            )}.`,
            480,
          )}
          {numberField(
            'minNoticeMinutes',
            'Minimum notice',
            `How close to the start a customer may still book — ${formatDuration(
              settings.minNoticeMinutes,
            )} today.`,
          )}
          {numberField(
            'maxHorizonDays',
            'Booking horizon (days)',
            'How far ahead the calendar is open.',
            730,
          )}
          {numberField(
            'defaultPreBufferMinutes',
            'Buffer before',
            'Time held before every appointment.',
            1440,
          )}
          {numberField(
            'defaultPostBufferMinutes',
            'Buffer after',
            'Time held after every appointment.',
            1440,
          )}
          {numberField(
            'noShowGraceMinutes',
            'No-show grace',
            'How long after the start a customer may still arrive.',
            1440,
          )}
          <Field
            label="Bookings per customer per day"
            hint="Blank means no limit."
            error={form.formState.errors.maxBookingsPerCustomerPerDay?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('maxBookingsPerCustomerPerDay')}
                inputMode="numeric"
                disabled={!canEdit}
              />
            )}
          </Field>
          <Field
            label="Bookings per provider per day"
            hint="Blank means no limit."
            error={form.formState.errors.maxBookingsPerStaffPerDay?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('maxBookingsPerStaffPerDay')}
                inputMode="numeric"
                disabled={!canEdit}
              />
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="What customers may do themselves"
          description="These apply to the customer-facing pages. Your own team is never held to them."
        />
        <CardBody className="flex flex-col gap-5">
          <Switch
            checked={form.watch('allowCustomerCancel')}
            onCheckedChange={(checked) =>
              form.setValue('allowCustomerCancel', checked, { shouldDirty: true })
            }
            disabled={!canEdit}
            label="Customers may cancel online"
          />
          <Switch
            checked={form.watch('allowCustomerReschedule')}
            onCheckedChange={(checked) =>
              form.setValue('allowCustomerReschedule', checked, { shouldDirty: true })
            }
            disabled={!canEdit}
            label="Customers may reschedule online"
          />
          <Switch
            checked={form.watch('requireApproval')}
            onCheckedChange={(checked) =>
              form.setValue('requireApproval', checked, { shouldDirty: true })
            }
            disabled={!canEdit}
            label="Review every booking"
            description="Everything arrives as Pending until someone approves it, whatever the service says."
          />

          <div className="grid gap-4 sm:grid-cols-3">
            {numberField(
              'cancellationDeadlineMinutes',
              'Cancellation deadline',
              `Minutes before the start — ${formatDuration(
                settings.cancellationDeadlineMinutes,
              )} today.`,
            )}
            {numberField(
              'rescheduleDeadlineMinutes',
              'Reschedule deadline',
              `Minutes before the start — ${formatDuration(
                settings.rescheduleDeadlineMinutes,
              )} today.`,
            )}
            {numberField(
              'maxReschedulesPerAppointment',
              'Reschedules allowed',
              'Per appointment, by the customer.',
              50,
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="Waitlist and reminders"
          description="What happens when a slot opens, and when customers are reminded."
        />
        <CardBody className="flex flex-col gap-5">
          <Switch
            checked={form.watch('waitlistEnabled')}
            onCheckedChange={(checked) =>
              form.setValue('waitlistEnabled', checked, { shouldDirty: true })
            }
            disabled={!canEdit}
            label="Keep a waitlist"
            description="Customers can ask to be told when a time opens up."
          />
          <Switch
            checked={form.watch('waitlistAutoBook')}
            onCheckedChange={(checked) =>
              form.setValue('waitlistAutoBook', checked, { shouldDirty: true })
            }
            disabled={!canEdit || !form.watch('waitlistEnabled')}
            label="Book the waitlist automatically"
            description="The first matching request is booked outright rather than offered."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            {numberField(
              'waitlistHoldMinutes',
              'Hold a slot for',
              'Minutes a waitlisted customer has to claim an offered slot.',
              10_080,
            )}
            <Field
              label="Reminder offsets"
              hint="Minutes before the start, comma separated. Up to five."
              error={form.formState.errors.reminderOffsetsMinutes?.message}
            >
              {(field) => (
                <Input
                  {...field}
                  {...form.register('reminderOffsetsMinutes')}
                  placeholder="1440, 120"
                  disabled={!canEdit}
                />
              )}
            </Field>
          </div>
          <p className="text-xs text-fg-muted">
            Currently reminding at{' '}
            {settings.reminderOffsetsMinutes.length === 0
              ? 'no point before the appointment'
              : settings.reminderOffsetsMinutes
                  .map((offset) => formatDuration(offset))
                  .join(' and ')}{' '}
            before the start.
          </p>
        </CardBody>
        {canEdit ? (
          <CardFooter>
            <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
              Save booking policy
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------------------

export default function WorkspaceSettingsPage(): JSX.Element {
  const { activeBusinessId } = useAuth();
  const [tab, setTab] = useState<'profile' | 'policy'>('profile');

  const workspaceQuery = useQuery({
    queryKey: ownerKeys.workspace(activeBusinessId),
    queryFn: () => api.get<Workspace>('/workspace'),
  });

  const settingsQuery = useQuery({
    queryKey: ownerKeys.workspaceSettings(activeBusinessId),
    queryFn: () => api.get<BusinessSettings>('/workspace/settings'),
  });

  // Both forms take their defaults from the fetched record, so they are mounted
  // only once it exists — a form initialised with blanks and then reset would
  // flash empty fields and mark itself dirty.
  const isPending = workspaceQuery.isPending || settingsQuery.isPending;
  const error = workspaceQuery.error ?? settingsQuery.error;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your workspace profile and the rules the booking engine applies to everything in it."
      >
        <Tabs
          label="Settings sections"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'profile', label: 'Profile', icon: <Building2 className="size-4" /> },
            {
              value: 'policy',
              label: 'Booking policy',
              icon: <SlidersHorizontal className="size-4" />,
            },
          ]}
        />
      </PageHeader>

      {isPending ? (
        <Card>
          <div className="flex flex-col gap-4 p-6" aria-live="polite">
            <span className="mf-sr-only">Loading settings</span>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Card>
      ) : error ? (
        <Card>
          <ErrorState
            error={error}
            onRetry={() => {
              void workspaceQuery.refetch();
              void settingsQuery.refetch();
            }}
          />
        </Card>
      ) : tab === 'profile' && workspaceQuery.data ? (
        <ProfilePanel key={workspaceQuery.data.updatedAt} workspace={workspaceQuery.data} />
      ) : settingsQuery.data ? (
        <PolicyPanel key={settingsQuery.data.updatedAt} settings={settingsQuery.data} />
      ) : null}
    </>
  );
}
