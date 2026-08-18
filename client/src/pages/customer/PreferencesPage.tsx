import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Info, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  Select,
  Switch,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { ApiError, api } from '@/lib/apiClient';
import { formatDuration } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { timezoneOptions } from '@/lib/timezones';
import type { BusinessSettings } from '@/types/api';
import { FormBanner } from '@/pages/auth/FormBanner';
import type { CustomerRecord } from './api';
import { CustomerRecordState } from './CustomerRecordState';
import { useMyCustomer } from './useMyCustomer';

/**
 * The reminder points a customer may choose from.
 *
 * Deliberately a short list of round numbers rather than a free minute field:
 * the API accepts any positive integer, but a reminder at 97 minutes is a
 * setting nobody wants and everybody mis-types.
 */
const REMINDER_CHOICES = [1440, 720, 240, 120, 60, 30];

interface Draft {
  timezone: string;
  phone: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  marketingOptIn: boolean;
  /** null means "follow the workspace's own schedule", which is the default. */
  reminderOffsetsMinutes: number[] | null;
}

function toDraft(customer: CustomerRecord, fallbackZone: string): Draft {
  const preferences = customer.communicationPreferences;
  return {
    timezone: customer.timezone ?? fallbackZone,
    phone: customer.phone ?? '',
    emailEnabled: preferences.emailEnabled,
    smsEnabled: preferences.smsEnabled,
    marketingOptIn: preferences.marketingOptIn,
    reminderOffsetsMinutes: preferences.reminderOffsetsMinutes ?? null,
  };
}

function sameOffsets(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function PreferencesPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, activeMembership, can } = useAuth();
  const { state, customer, refetch } = useMyCustomer();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mayEdit = can(PERMISSIONS.CUSTOMERS_MANAGE);
  /** Null until the reader touches something — the stored record shows through. */
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverDraft = useMemo(
    () => (customer ? toDraft(customer, activeTimezone) : null),
    [customer, activeTimezone],
  );

  /*
   * A fresh record from the server discards an in-progress draft.
   *
   * `customer` keeps its identity across a refetch that returns the same bytes
   * — TanStack Query's structural sharing sees to that — so this fires when the
   * stored record genuinely changed, not every time the window regains focus.
   */
  useEffect(() => setEdits(null), [serverDraft]);

  // The workspace's own reminder schedule, shown as the effective one whenever
  // the customer has not overridden it. Never invented — if this read fails the
  // page says the schedule is unknown rather than guessing at it.
  const settingsQuery = useQuery({
    queryKey: ['workspace', 'settings', activeBusinessId],
    queryFn: () => api.get<BusinessSettings>('/workspace/settings'),
    staleTime: 10 * 60_000,
  });

  const customerId = customer?.id ?? '';

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<CustomerRecord>(`/customers/${customerId}`, body),
    onSuccess: () => {
      setSaveError(null);
      toast({ title: 'Preferences saved', tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['customer', 'record'] });
    },
    onError: (error: unknown) => {
      setSaveError(
        error instanceof ApiError
          ? [error.message, ...error.details.map((detail) => detail.message)].join(' ')
          : 'We could not save that. Please try again.',
      );
    },
  });

  const zones = useMemo(() => timezoneOptions(), []);

  if (state.status !== 'ready' || serverDraft === null) {
    return (
      <>
        <PageHeader
          title="Preferences"
          description="How this workspace reaches you, and the clock your bookings are shown in."
        />
        <CustomerRecordState
          state={state.status === 'ready' ? { status: 'loading' } : state}
          onRetry={refetch}
        />
      </>
    );
  }

  const draft = edits ?? serverDraft;
  const workspaceOffsets = settingsQuery.data?.reminderOffsetsMinutes ?? null;
  const effectiveOffsets = draft.reminderOffsetsMinutes ?? workspaceOffsets;

  const dirty =
    draft.timezone !== serverDraft.timezone ||
    draft.phone !== serverDraft.phone ||
    draft.emailEnabled !== serverDraft.emailEnabled ||
    draft.smsEnabled !== serverDraft.smsEnabled ||
    draft.marketingOptIn !== serverDraft.marketingOptIn ||
    !sameOffsets(draft.reminderOffsetsMinutes, serverDraft.reminderOffsetsMinutes);

  const update = (patch: Partial<Draft>): void =>
    setEdits((current) => ({ ...(current ?? serverDraft), ...patch }));

  const toggleOffset = (minutes: number): void => {
    const current = draft.reminderOffsetsMinutes ?? workspaceOffsets ?? [];
    const next = current.includes(minutes)
      ? current.filter((value) => value !== minutes)
      : [...current, minutes].sort((a, b) => b - a);
    update({ reminderOffsetsMinutes: next });
  };

  const onSave = (): void => {
    const body: Record<string, unknown> = {};
    const preferences: Record<string, unknown> = {};

    if (draft.timezone !== serverDraft.timezone) body.timezone = draft.timezone;
    if (draft.phone !== serverDraft.phone)
      body.phone = draft.phone.trim() === '' ? null : draft.phone.trim();
    if (draft.emailEnabled !== serverDraft.emailEnabled)
      preferences.emailEnabled = draft.emailEnabled;
    if (draft.smsEnabled !== serverDraft.smsEnabled) preferences.smsEnabled = draft.smsEnabled;
    if (draft.marketingOptIn !== serverDraft.marketingOptIn) {
      preferences.marketingOptIn = draft.marketingOptIn;
    }
    if (
      draft.reminderOffsetsMinutes !== null &&
      !sameOffsets(draft.reminderOffsetsMinutes, serverDraft.reminderOffsetsMinutes)
    ) {
      preferences.reminderOffsetsMinutes = draft.reminderOffsetsMinutes;
    }

    if (Object.keys(preferences).length > 0) body.communicationPreferences = preferences;
    if (Object.keys(body).length === 0) return;

    setSaveError(null);
    mutation.mutate(body);
  };

  const workspaceName = activeMembership?.businessName ?? 'This workspace';

  return (
    <>
      <PageHeader
        title="Preferences"
        description={`How ${workspaceName} reaches you, and the clock your bookings are shown in.`}
      />

      {!mayEdit ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-border bg-surface-sunken px-3.5 py-3 text-sm text-fg-secondary"
        >
          <Lock className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          <p className="leading-relaxed">
            These are your settings as {workspaceName} holds them. Your role cannot change customer
            records here, so everything below is read-only — ask them to update it for you.
          </p>
        </div>
      ) : null}

      <FormBanner message={saveError} />

      <Card>
        <CardHeader
          as="h2"
          title="Your clock"
          description="Every time you see across MeetFlow is converted into this zone."
        />
        <CardBody className="flex flex-col gap-4">
          <Field
            label="Timezone"
            hint="Reminders are timed against your calendar day, so this needs to be a real place rather than an offset."
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                options={zones}
                value={draft.timezone}
                disabled={!mayEdit}
                onChange={(event) => update({ timezone: event.target.value })}
              />
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="How they reach you"
          description="Booking confirmations, changes and cancellations always go out; these control the rest."
        />
        <CardBody className="flex flex-col gap-5">
          <Switch
            checked={draft.emailEnabled}
            onCheckedChange={(checked) => update({ emailEnabled: checked })}
            disabled={!mayEdit}
            label="Email"
            description={`Sent to ${state.customer.email ?? 'your address'}.`}
          />

          <Switch
            checked={draft.smsEnabled}
            onCheckedChange={(checked) => update({ smsEnabled: checked })}
            disabled={!mayEdit || draft.phone.trim() === ''}
            label="Text message"
            description={
              draft.phone.trim() === ''
                ? 'Add a mobile number below to turn this on.'
                : `Sent to ${draft.phone}.`
            }
          />

          <Field label="Mobile number" hint="Used only for booking messages.">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="tel"
                autoComplete="tel"
                value={draft.phone}
                disabled={!mayEdit}
                placeholder="+91 98450 10001"
                onChange={(event) => update({ phone: event.target.value })}
              />
            )}
          </Field>

          <Switch
            checked={draft.marketingOptIn}
            onCheckedChange={(checked) => update({ marketingOptIn: checked })}
            disabled={!mayEdit}
            label="News and offers"
            description={`Occasional messages from ${workspaceName} that are not about a specific booking.`}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="Reminders"
          description="How long before an appointment you want to hear about it."
        />
        <CardBody className="flex flex-col gap-4">
          <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3.5 py-2.5 text-sm leading-relaxed text-fg-secondary">
            <Info className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
            {draft.reminderOffsetsMinutes === null ? (
              workspaceOffsets === null ? (
                <span>
                  You are following {workspaceName}’s own reminder schedule. We could not read what
                  that schedule is, so nothing is shown here rather than a guess.
                </span>
              ) : (
                <span>
                  You are following {workspaceName}’s schedule:{' '}
                  {workspaceOffsets.map((value) => formatDuration(value)).join(' and ')} before.
                  Choosing below replaces it with your own.
                </span>
              )
            ) : (
              <span>
                You have your own schedule. Clearing every option below means no reminders at all.
              </span>
            )}
          </p>

          <fieldset className="flex flex-col gap-3" disabled={!mayEdit}>
            <legend className="mf-sr-only">Reminder times</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {REMINDER_CHOICES.map((minutes) => (
                <Checkbox
                  key={minutes}
                  label={`${formatDuration(minutes)} before`}
                  checked={effectiveOffsets?.includes(minutes) ?? false}
                  onChange={() => toggleOffset(minutes)}
                />
              ))}
            </div>
            {draft.reminderOffsetsMinutes !== null ? (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Bell className="size-4" aria-hidden="true" />}
                  onClick={() => update({ reminderOffsetsMinutes: null })}
                >
                  Go back to the workspace schedule
                </Button>
              </div>
            ) : null}
          </fieldset>
        </CardBody>
      </Card>

      {mayEdit ? (
        // One save bar for the whole page: the three cards are one record, and
        // a button per card would imply three separate requests.
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <p className="mr-auto text-sm text-fg-muted" aria-live="polite">
            {dirty ? 'You have unsaved changes' : 'Everything is saved'}
          </p>
          <Button variant="secondary" onClick={() => setEdits(null)} disabled={!dirty}>
            Discard
          </Button>
          <Button onClick={onSave} loading={mutation.isPending} disabled={!dirty}>
            Save preferences
          </Button>
        </div>
      ) : null}
    </>
  );
}
