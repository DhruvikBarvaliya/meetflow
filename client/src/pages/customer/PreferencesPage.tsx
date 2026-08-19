/**
 * How the businesses a person books with are allowed to contact them.
 *
 * Reads and writes `/me/preferences`, which is one set of switches applied to
 * every workspace that holds a record of them at once. That is the server's
 * decision and it shapes this page: the request may not name a workspace — the
 * portal never accepts one — and somebody who no longer wants reminder emails
 * wants them to stop, not to be switched off four times.
 *
 * The cost of that choice is `divergent`, and the page reports it rather than
 * hiding it. Staff can still edit these same fields from a workspace's address
 * book, so the four records can disagree. When they do there is no honest single
 * value to show; the server hands back the conservative reading and this page
 * says the settings currently differ instead of presenting one business's answer
 * as though it were universal.
 *
 * The old version of this page also edited a phone number and a timezone
 * through `PATCH /customers/:id`, which needed `customers:manage` — a permission
 * a customer does not hold, so the controls rendered disabled for exactly the
 * people they were built for. Those two fields belong to each workspace's own
 * record and are not part of this contract, so they are gone rather than
 * present-and-broken, and the page says where they live.
 */
import { Bell, Info, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ErrorState,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui';
import { isApiError } from '@/lib/apiClient';
import { formatDuration } from '@/lib/format';
import { FormBanner } from '@/pages/auth/FormBanner';
import {
  usePortalPreferences,
  useUpdatePortalPreferences,
  type PortalPreferences,
} from './portalApi';

/**
 * The reminder points on offer.
 *
 * A short list of round numbers rather than a free minute field: the API accepts
 * any positive integer up to thirty days, but a reminder at 97 minutes is a
 * setting nobody wants and everybody mistypes.
 */
const REMINDER_CHOICES = [1440, 720, 240, 120, 60, 30];

function sameOffsets(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePreferences(a: PortalPreferences, b: PortalPreferences): boolean {
  return (
    a.emailEnabled === b.emailEnabled &&
    a.smsEnabled === b.smsEnabled &&
    a.marketingOptIn === b.marketingOptIn &&
    sameOffsets(a.reminderOffsetsMinutes, b.reminderOffsetsMinutes)
  );
}

export default function PreferencesPage(): JSX.Element {
  const preferencesQuery = usePortalPreferences();
  const update = useUpdatePortalPreferences();
  const { toast } = useToast();

  /** Null until the reader touches something — the stored values show through. */
  const [edits, setEdits] = useState<PortalPreferences | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stored = preferencesQuery.data?.preferences ?? null;

  /*
   * A fresh answer from the server discards an in-progress draft.
   *
   * `stored` keeps its identity across a refetch that returns the same bytes —
   * TanStack Query's structural sharing sees to that — so this fires when the
   * stored values genuinely changed, not every time the window regains focus.
   */
  useEffect(() => setEdits(null), [stored]);

  const zoneNote = useMemo(
    () => 'Booking confirmations, changes and cancellations always go out; these control the rest.',
    [],
  );

  if (preferencesQuery.isPending) {
    return (
      <>
        <PageHeader title="Preferences" description={zoneNote} />
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardBody>
        </Card>
      </>
    );
  }

  if (preferencesQuery.isError || !preferencesQuery.data || stored === null) {
    return (
      <>
        <PageHeader title="Preferences" description={zoneNote} />
        <Card>
          <ErrorState
            error={preferencesQuery.error}
            title="We could not load your preferences"
            onRetry={() => void preferencesQuery.refetch()}
          />
        </Card>
      </>
    );
  }

  const { divergent, workspaceCount } = preferencesQuery.data;
  const draft = edits ?? stored;
  const dirty = !samePreferences(draft, stored);

  // No linked workspace means there is nowhere to store any of this: the server
  // answers 409 rather than pretending to save, and a switch that sprang back on
  // the next load would be a lie the reader has no way to detect.
  const nowhereToStore = workspaceCount === 0;

  const change = (patch: Partial<PortalPreferences>): void =>
    setEdits((current) => ({ ...(current ?? stored), ...patch }));

  const toggleOffset = (minutes: number): void => {
    const current = draft.reminderOffsetsMinutes ?? [];
    const next = current.includes(minutes)
      ? current.filter((value) => value !== minutes)
      : [...current, minutes].sort((a, b) => b - a);
    change({ reminderOffsetsMinutes: next });
  };

  const onSave = (): void => {
    // Only what actually moved. The server merges this patch over what is
    // stored, so sending an untouched field would overwrite whatever a workspace
    // last set on it.
    const patch: Partial<PortalPreferences> = {};
    if (draft.emailEnabled !== stored.emailEnabled) patch.emailEnabled = draft.emailEnabled;
    if (draft.smsEnabled !== stored.smsEnabled) patch.smsEnabled = draft.smsEnabled;
    if (draft.marketingOptIn !== stored.marketingOptIn) {
      patch.marketingOptIn = draft.marketingOptIn;
    }
    if (!sameOffsets(draft.reminderOffsetsMinutes, stored.reminderOffsetsMinutes)) {
      patch.reminderOffsetsMinutes = draft.reminderOffsetsMinutes;
    }
    if (Object.keys(patch).length === 0) return;

    setSaveError(null);
    update.mutate(patch, {
      onSuccess: () => {
        setEdits(null);
        toast({ title: 'Preferences saved', tone: 'success' });
      },
      onError: (error: unknown) => {
        setSaveError(
          isApiError(error) ? error.message : 'We could not save that. Please try again.',
        );
      },
    });
  };

  const businessesPhrase =
    workspaceCount === 1
      ? 'the business you book with'
      : `all ${workspaceCount} businesses you book with`;

  return (
    <>
      <PageHeader
        title="Preferences"
        description={nowhereToStore ? zoneNote : `These apply to ${businessesPhrase}. ${zoneNote}`}
      />

      {nowhereToStore ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-border bg-surface-sunken px-3.5 py-3 text-sm text-fg-secondary"
        >
          <Lock className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          <p className="leading-relaxed">
            There is nowhere to store these yet. Contact preferences are kept against your record
            with each business, and you have no record with any of them so far — book once and this
            page starts working.
          </p>
        </div>
      ) : null}

      {divergent ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3.5 py-3 text-sm text-warning-text"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            These settings currently differ between the businesses you book with — staff can change
            them from their own side. What is shown below is the cautious reading of the lot: a
            switch is only on here when it is on everywhere. Saving applies your choice to all of
            them.
          </p>
        </div>
      ) : null}

      <FormBanner message={saveError} />

      <Card>
        <CardHeader
          as="h2"
          title="How they reach you"
          description="Confirmations for a booking are always sent. These cover everything else."
        />
        <CardBody className="flex flex-col gap-5">
          <Switch
            checked={draft.emailEnabled}
            onCheckedChange={(checked) => change({ emailEnabled: checked })}
            disabled={nowhereToStore}
            label="Email"
            description="Reminders and updates about your bookings."
          />

          <Switch
            checked={draft.smsEnabled}
            onCheckedChange={(checked) => change({ smsEnabled: checked })}
            disabled={nowhereToStore}
            label="Text message"
            // Honest about the dependency: the number is not editable from here,
            // so promising texts without one would be a switch that does nothing.
            description="Only sent where the business holds a mobile number for you. Ask them to add or change it."
          />

          <Switch
            checked={draft.marketingOptIn}
            onCheckedChange={(checked) => change({ marketingOptIn: checked })}
            disabled={nowhereToStore}
            label="News and offers"
            description="Occasional messages that are not about a specific booking."
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
              // Deliberately does not list the schedules being followed. Each
              // business sets its own and the portal cannot read them, and a
              // plausible-looking guess would be worse than saying nothing.
              <span>
                You are following each business&rsquo;s own reminder schedule. Those schedules are
                theirs to set, so they are not listed here. Choosing below replaces them with yours,
                everywhere.
              </span>
            ) : (
              <span>
                You have your own schedule, and it applies wherever you book. Clearing every option
                below means no reminders at all.
              </span>
            )}
          </p>

          <fieldset className="flex flex-col gap-3" disabled={nowhereToStore}>
            <legend className="mf-sr-only">Reminder times</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {REMINDER_CHOICES.map((minutes) => (
                <Checkbox
                  key={minutes}
                  label={`${formatDuration(minutes)} before`}
                  checked={draft.reminderOffsetsMinutes?.includes(minutes) ?? false}
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
                  onClick={() => change({ reminderOffsetsMinutes: null })}
                >
                  Go back to each business&rsquo;s own schedule
                </Button>
              </div>
            ) : null}
          </fieldset>
        </CardBody>
      </Card>

      {!nowhereToStore ? (
        // One save bar for the whole page: these are one record, and a button
        // per card would imply separate requests that could half-succeed.
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <p className="mr-auto text-sm text-fg-muted" aria-live="polite">
            {dirty ? 'You have unsaved changes' : 'Everything is saved'}
          </p>
          <Button variant="secondary" onClick={() => setEdits(null)} disabled={!dirty}>
            Discard
          </Button>
          <Button onClick={onSave} loading={update.isPending} disabled={!dirty}>
            Save preferences
          </Button>
        </div>
      ) : null}
    </>
  );
}
