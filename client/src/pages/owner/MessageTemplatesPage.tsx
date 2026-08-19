import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Mail, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout';
import { DataState } from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { isApiError } from '@/lib/apiClient';
import { formatRelative, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import type {
  NotificationTemplate,
  NotificationTemplatePreview,
  TemplatePlaceholder,
} from '@/types/api';
import {
  fetchNotificationTemplates,
  previewNotificationTemplate,
  resetNotificationTemplate,
  saveNotificationTemplate,
  workspaceKeys,
} from './workspaceApi';

/**
 * The messages this workspace sends, and the copy that goes out in its name.
 *
 * `resolveTemplate` on the server has always preferred a workspace row over the
 * built-in default. Nothing ever wrote one — no seeder, no route — so the whole
 * first branch of that lookup was dead in every environment, and
 * `templates:manage` was a permission the built-in roles granted to owners and
 * managers while guarding nothing at all. This page is the other half.
 *
 * Three things about the shape of the problem drive the design.
 *
 * **An unknown placeholder is silent.** `renderTemplate` substitutes a name it
 * does not recognise with an empty string, so `{{cusotmerName}}` ships an email
 * opening "Hi ," to every customer, with nothing logged and nothing to notice
 * until somebody replies to complain. The server refuses such a body, and this
 * page puts the available names one click away — a reference list beside the
 * editor, each chip inserting itself at the cursor — so the refusal is a
 * backstop rather than the first time an operator learns what exists.
 *
 * **A default is not a copy.** Restoring drops the workspace's row entirely, so
 * the next send reads MeetFlow's current copy and picks up every later
 * improvement to it. The screen therefore says "MeetFlow's default", not "the
 * original", because the two are different promises and only the first is true.
 *
 * **Preview before save, not after.** The question an operator is asking is
 * "should I save this", and a preview that only works on saved copy answers it
 * too late. The preview endpoint takes the draft and runs the same validation,
 * so it can never show a template the save would refuse.
 */

/** Reads as a sentence in the list, where the raw key does not. */
const TEMPLATE_TITLES: Record<string, string> = {
  BOOKING_CONFIRMATION: 'Booking confirmed',
  BOOKING_PENDING_APPROVAL: 'Booking awaiting your approval',
  BOOKING_APPROVED: 'Booking approved',
  BOOKING_REJECTED: 'Booking declined',
  BOOKING_CANCELLED: 'Booking cancelled',
  BOOKING_RESCHEDULED: 'Booking moved',
  APPOINTMENT_REMINDER: 'Appointment reminder',
  APPOINTMENT_FOLLOW_UP: 'After the appointment',
  APPOINTMENT_NO_SHOW: 'Marked as a no-show',
  WAITLIST_SLOT_AVAILABLE: 'A waitlisted time opened up',
  WAITLIST_CONFIRMED: 'Added to the waitlist',
  STAFF_ASSIGNED: 'A booking landed in your diary',
  STAFF_SCHEDULE_CHANGED: 'Your diary changed',
  OWNER_DAILY_DIGEST: 'Your day ahead',
  OWNER_NEW_BOOKING: 'A new booking came in',
  CUSTOMER_WELCOME: 'Welcome to the workspace',
};

/** Who receives each message, which is not always obvious from its name. */
const TEMPLATE_AUDIENCE: Record<string, string> = {
  STAFF_ASSIGNED: 'Sent to the provider',
  STAFF_SCHEDULE_CHANGED: 'Sent to the provider',
  OWNER_DAILY_DIGEST: 'Sent to the owner',
  OWNER_NEW_BOOKING: 'Sent to the owner',
};

function titleOf(template: NotificationTemplate): string {
  return TEMPLATE_TITLES[template.key] ?? humanizeEnum(template.key);
}

function addressOf(template: NotificationTemplate): string {
  return `${template.key}:${template.channel}`;
}

// ---------------------------------------------------------------------------
// Placeholder reference
// ---------------------------------------------------------------------------

/**
 * The names this message can fill, each inserting itself where the cursor is.
 *
 * Inserting rather than copying: an operator who has to select, copy and paste
 * a placeholder is an operator who will eventually type one instead, and typing
 * one is exactly the failure the server refuses and this list exists to
 * prevent.
 */
function PlaceholderList({
  placeholders,
  onInsert,
}: {
  placeholders: TemplatePlaceholder[];
  onInsert: (name: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Available in this message</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Click one to insert it. Anything else is refused when you save, because it would be sent
          as empty text.
        </p>
      </div>
      <ul className="space-y-2">
        {placeholders.map((placeholder) => (
          <li key={placeholder.name}>
            <button
              type="button"
              onClick={() => onInsert(placeholder.name)}
              className="border-border hover:border-primary hover:bg-muted/50 focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:outline-none"
            >
              <code className="text-primary text-xs font-semibold">{`{{${placeholder.name}}}`}</code>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {placeholder.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MessageTemplatesPage() {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mayManage = can(PERMISSIONS.TEMPLATES_MANAGE);

  const templatesQuery = useQuery({
    queryKey: workspaceKeys.notificationTemplates(activeBusinessId),
    queryFn: fetchNotificationTemplates,
  });

  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const selected = useMemo(
    () => templates.find((template) => addressOf(template) === selectedAddress) ?? templates[0],
    [templates, selectedAddress],
  );

  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [preview, setPreview] = useState<NotificationTemplatePreview | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // The editor follows the selection, and re-seeds when the row behind it
  // changes — after a save or a reset the server's answer is the truth, not the
  // text left in the box.
  useEffect(() => {
    setSubject(selected?.subject ?? '');
    setBodyText(selected?.bodyText ?? '');
    setPreview(null);
  }, [selected?.key, selected?.channel, selected?.updatedAt, selected?.source]);

  const dirty =
    selected !== undefined &&
    (subject !== (selected.subject ?? '') || bodyText !== selected.bodyText);

  function insertPlaceholder(name: string) {
    setBodyText((current) => `${current}{{${name}}}`);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      saveNotificationTemplate(selected!.key, selected!.channel, {
        subject: subject.trim() === '' ? undefined : subject,
        bodyText,
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Saved', description: 'New messages will use your copy.' });
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.notificationTemplates(activeBusinessId),
      });
    },
    onError: (error: unknown) => {
      // The placeholder refusal names the offending name and lists the
      // alternatives, so it is shown as it is rather than replaced with a
      // generic apology.
      toast({
        tone: 'error',
        title: 'Not saved',
        description: isApiError(error) ? error.message : 'That message could not be saved.',
      });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => resetNotificationTemplate(selected!.key, selected!.channel),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Restored',
        description: 'This message follows MeetFlow’s default again.',
      });
      setConfirmingReset(false);
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.notificationTemplates(activeBusinessId),
      });
    },
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Not restored',
        description: isApiError(error) ? error.message : 'That message could not be restored.',
      });
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewNotificationTemplate(selected!.key, selected!.channel, {
        subject: subject.trim() === '' ? undefined : subject,
        bodyText,
      }),
    onSuccess: setPreview,
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Not previewed',
        description: isApiError(error) ? error.message : 'That draft could not be previewed.',
      });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description={
          mayManage
            ? 'The emails your customers and team receive. Rewrite any of them, or leave them following MeetFlow’s copy — those improve over time; yours stay exactly as you write them.'
            : 'The emails your customers and team receive. Changing them needs the message-templates permission, which the built-in roles grant to owners and managers.'
        }
      />

      <DataState
        isPending={templatesQuery.isPending}
        isError={templatesQuery.isError}
        error={templatesQuery.error}
        onRetry={() => void templatesQuery.refetch()}
        isEmpty={templates.length === 0}
        empty={
          <EmptyState
            icon={<Mail className="size-6" aria-hidden="true" />}
            title="No messages to show"
            description="MeetFlow defines the messages this workspace can send. If this list is empty, something is wrong with the catalogue rather than with your workspace."
          />
        }
        columns={2}
      >
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <Card className="p-2">
            <ul className="space-y-1">
              {templates.map((template) => {
                const isSelected = selected && addressOf(selected) === addressOf(template);
                return (
                  <li key={addressOf(template)}>
                    <button
                      type="button"
                      onClick={() => setSelectedAddress(addressOf(template))}
                      aria-current={isSelected ? 'true' : undefined}
                      className={`focus-visible:ring-ring w-full rounded-md px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:outline-none ${
                        isSelected ? 'bg-muted' : 'hover:bg-muted/50'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{titleOf(template)}</span>
                        {template.source === 'WORKSPACE' ? <Badge tone="info">Yours</Badge> : null}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        {TEMPLATE_AUDIENCE[template.key] ?? 'Sent to the customer'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected ? (
            <div className="space-y-4">
              <Card className="space-y-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{titleOf(selected)}</h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {selected.source === 'WORKSPACE' ? (
                        <>
                          Your copy, in use since{' '}
                          {selected.updatedAt
                            ? formatRelative(selected.updatedAt, activeTimezone)
                            : 'recently'}
                          .
                        </>
                      ) : (
                        <>
                          Following MeetFlow’s default. Save your own copy and this message stops
                          changing when the default does.
                        </>
                      )}
                    </p>
                  </div>
                  {selected.source === 'WORKSPACE' && mayManage ? (
                    <Button
                      variant="ghost"
                      leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
                      onClick={() => setConfirmingReset(true)}
                    >
                      Restore MeetFlow’s
                    </Button>
                  ) : null}
                </div>

                <Field label="Subject line">
                  {(field) => (
                    <Input
                      {...field}
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      disabled={!mayManage}
                      placeholder={selected.defaultSubject ?? ''}
                    />
                  )}
                </Field>

                <Field
                  label="Message"
                  hint="Placeholders in double braces are filled in when the message is sent."
                >
                  {(field) => (
                    <Textarea
                      {...field}
                      rows={14}
                      value={bodyText}
                      onChange={(event) => setBodyText(event.target.value)}
                      disabled={!mayManage}
                      className="font-mono text-sm"
                    />
                  )}
                </Field>

                {mayManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      leadingIcon={<Save className="size-4" aria-hidden="true" />}
                      onClick={() => saveMutation.mutate()}
                      disabled={!dirty || bodyText.trim() === ''}
                      loading={saveMutation.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      variant="secondary"
                      leadingIcon={<Eye className="size-4" aria-hidden="true" />}
                      onClick={() => previewMutation.mutate()}
                      disabled={bodyText.trim() === ''}
                      loading={previewMutation.isPending}
                    >
                      Preview
                    </Button>
                  </div>
                ) : null}
              </Card>

              <Card className="p-6">
                <PlaceholderList
                  placeholders={selected.placeholders}
                  onInsert={mayManage ? insertPlaceholder : () => undefined}
                />
              </Card>
            </div>
          ) : null}
        </div>
      </DataState>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Preview"
        description="Rendered with sample details, so you can read it the way a recipient will. Nothing has been saved."
      >
        {preview ? (
          <div className="space-y-4">
            {preview.subject ? (
              <div>
                <p className="text-muted-foreground text-xs font-semibold uppercase">Subject</p>
                <p className="mt-1 text-sm font-medium">{preview.subject}</p>
              </div>
            ) : null}
            <div>
              <p className="text-muted-foreground text-xs font-semibold uppercase">Message</p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{preview.bodyText}</p>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={confirmingReset}
        onCancel={() => setConfirmingReset(false)}
        onConfirm={() => resetMutation.mutate()}
        title="Restore MeetFlow’s copy?"
        description="Your version of this message is deleted. From then on it follows MeetFlow’s default, including any later improvements to it — so this is not the same as pasting the original text back."
        confirmLabel="Restore"
        loading={resetMutation.isPending}
        destructive
      />
    </div>
  );
}
