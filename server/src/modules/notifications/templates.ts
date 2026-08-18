/**
 * Built-in notification templates and the tiny renderer that fills them.
 *
 * A workspace may override any of these with a row in `notification_templates`;
 * these are the fallbacks that ship with the product so notifications work the
 * moment a business is created, with nothing to configure.
 */

export type TemplateKey =
  | 'BOOKING_CONFIRMATION'
  | 'BOOKING_PENDING_APPROVAL'
  | 'BOOKING_APPROVED'
  | 'BOOKING_REJECTED'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_RESCHEDULED'
  | 'APPOINTMENT_REMINDER'
  | 'APPOINTMENT_FOLLOW_UP'
  | 'APPOINTMENT_NO_SHOW'
  | 'WAITLIST_SLOT_AVAILABLE'
  | 'WAITLIST_CONFIRMED'
  | 'STAFF_ASSIGNED'
  | 'STAFF_SCHEDULE_CHANGED'
  | 'OWNER_DAILY_DIGEST'
  | 'OWNER_NEW_BOOKING'
  | 'CUSTOMER_WELCOME';

export interface TemplateDefinition {
  key: TemplateKey;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  subject: string;
  bodyText: string;
}

/**
 * Placeholders available to every appointment template:
 *   customerName, businessName, serviceName, staffName, locationName,
 *   startsAtLocal, timezone, durationMinutes, manageUrl, reason
 */
export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'BOOKING_CONFIRMATION',
    channel: 'EMAIL',
    subject: 'Your {{serviceName}} appointment is confirmed',
    bodyText: `Hi {{customerName}},

Your appointment with {{businessName}} is confirmed.

  Service:  {{serviceName}}
  When:     {{startsAtLocal}} ({{timezone}})
  Duration: {{durationMinutes}} minutes
  With:     {{staffName}}
  Where:    {{locationName}}

Need to change it? Manage your booking here:
{{manageUrl}}

— {{businessName}}`,
  },
  {
    key: 'BOOKING_PENDING_APPROVAL',
    channel: 'EMAIL',
    subject: 'We have received your {{serviceName}} request',
    bodyText: `Hi {{customerName}},

Thanks for your request. {{businessName}} needs to approve it before it is confirmed.

  Service: {{serviceName}}
  Request: {{startsAtLocal}} ({{timezone}})

We will email you as soon as it is reviewed.

Manage your request:
{{manageUrl}}

— {{businessName}}`,
  },
  {
    key: 'BOOKING_APPROVED',
    channel: 'EMAIL',
    subject: 'Your {{serviceName}} appointment has been approved',
    bodyText: `Hi {{customerName}},

Good news — {{businessName}} has approved your appointment.

  Service: {{serviceName}}
  When:    {{startsAtLocal}} ({{timezone}})
  With:    {{staffName}}
  Where:   {{locationName}}

Manage your booking:
{{manageUrl}}

— {{businessName}}`,
  },
  {
    key: 'BOOKING_REJECTED',
    channel: 'EMAIL',
    subject: 'About your {{serviceName}} request',
    bodyText: `Hi {{customerName}},

Unfortunately {{businessName}} could not accept your request for {{startsAtLocal}} ({{timezone}}).

{{reason}}

You are welcome to choose another time:
{{bookingUrl}}

— {{businessName}}`,
  },
  {
    key: 'BOOKING_CANCELLED',
    channel: 'EMAIL',
    subject: 'Your {{serviceName}} appointment has been cancelled',
    bodyText: `Hi {{customerName}},

Your appointment on {{startsAtLocal}} ({{timezone}}) with {{businessName}} has been cancelled.

{{reason}}

Book another time whenever you are ready:
{{bookingUrl}}

— {{businessName}}`,
  },
  {
    key: 'BOOKING_RESCHEDULED',
    channel: 'EMAIL',
    subject: 'Your {{serviceName}} appointment has moved',
    bodyText: `Hi {{customerName}},

Your appointment with {{businessName}} has been rescheduled.

  Was:  {{previousStartsAtLocal}}
  Now:  {{startsAtLocal}} ({{timezone}})
  With: {{staffName}}
  Where:{{locationName}}

Manage your booking:
{{manageUrl}}

— {{businessName}}`,
  },
  {
    key: 'APPOINTMENT_REMINDER',
    channel: 'EMAIL',
    subject: 'Reminder: {{serviceName}} on {{startsAtLocal}}',
    bodyText: `Hi {{customerName}},

A reminder about your upcoming appointment with {{businessName}}.

  Service: {{serviceName}}
  When:    {{startsAtLocal}} ({{timezone}})
  With:    {{staffName}}
  Where:   {{locationName}}

Need to reschedule or cancel?
{{manageUrl}}

— {{businessName}}`,
  },
  {
    key: 'APPOINTMENT_FOLLOW_UP',
    channel: 'EMAIL',
    subject: 'Thanks for visiting {{businessName}}',
    bodyText: `Hi {{customerName}},

Thank you for your {{serviceName}} appointment on {{startsAtLocal}}.

Ready to book again?
{{bookingUrl}}

— {{businessName}}`,
  },
  {
    key: 'APPOINTMENT_NO_SHOW',
    channel: 'EMAIL',
    subject: 'We missed you at {{businessName}}',
    bodyText: `Hi {{customerName}},

We had you booked for {{serviceName}} on {{startsAtLocal}} ({{timezone}}) but you were not able to make it.

Book another time here:
{{bookingUrl}}

— {{businessName}}`,
  },
  {
    key: 'WAITLIST_SLOT_AVAILABLE',
    channel: 'EMAIL',
    subject: 'A {{serviceName}} slot has opened up',
    bodyText: `Hi {{customerName}},

A slot matching your waitlist request has become available at {{businessName}}.

  Service: {{serviceName}}
  When:    {{startsAtLocal}} ({{timezone}})

This slot is held for you until {{holdExpiresAtLocal}}. Claim it here:
{{claimUrl}}

— {{businessName}}`,
  },
  {
    key: 'WAITLIST_CONFIRMED',
    channel: 'EMAIL',
    subject: 'You are on the waitlist for {{serviceName}}',
    bodyText: `Hi {{customerName}},

You are on the waitlist for {{serviceName}} at {{businessName}}, between {{earliestDate}} and {{latestDate}}.

We will email you the moment a matching slot opens up.

— {{businessName}}`,
  },
  {
    key: 'STAFF_ASSIGNED',
    channel: 'EMAIL',
    subject: 'New appointment: {{serviceName}} on {{startsAtLocal}}',
    bodyText: `Hi {{staffName}},

A new appointment has been assigned to you.

  Service:  {{serviceName}}
  Customer: {{customerName}}
  When:     {{startsAtLocal}} ({{timezone}})
  Where:    {{locationName}}

Open your schedule:
{{dashboardUrl}}

— MeetFlow`,
  },
  {
    key: 'STAFF_SCHEDULE_CHANGED',
    channel: 'EMAIL',
    subject: 'Your schedule has changed on {{startsAtLocal}}',
    bodyText: `Hi {{staffName}},

An appointment in your schedule has changed.

  Service: {{serviceName}}
  Now:     {{startsAtLocal}} ({{timezone}})
  Change:  {{changeSummary}}

Open your schedule:
{{dashboardUrl}}

— MeetFlow`,
  },
  {
    key: 'OWNER_NEW_BOOKING',
    channel: 'EMAIL',
    subject: 'New booking: {{serviceName}} on {{startsAtLocal}}',
    bodyText: `A new appointment has been booked at {{businessName}}.

  Service:  {{serviceName}}
  Customer: {{customerName}}
  When:     {{startsAtLocal}} ({{timezone}})
  With:     {{staffName}}

Open your dashboard:
{{dashboardUrl}}

— MeetFlow`,
  },
  {
    key: 'OWNER_DAILY_DIGEST',
    channel: 'EMAIL',
    subject: 'Your day at {{businessName}}: {{appointmentCount}} appointments',
    bodyText: `Good morning,

Here is today at {{businessName}}:

  Appointments: {{appointmentCount}}
  First:        {{firstAppointmentLocal}}
  Last:         {{lastAppointmentLocal}}

Open your dashboard:
{{dashboardUrl}}

— MeetFlow`,
  },
  {
    key: 'CUSTOMER_WELCOME',
    channel: 'EMAIL',
    subject: 'Welcome to {{businessName}}',
    bodyText: `Hi {{customerName}},

Thanks for booking with {{businessName}}. You can view and manage all of your appointments here:
{{manageUrl}}

— {{businessName}}`,
  },
];

/** Account emails, which belong to the platform rather than to a workspace. */
export const SYSTEM_TEMPLATES = {
  EMAIL_VERIFICATION: {
    subject: 'Confirm your MeetFlow email address',
    bodyText: `Hi {{firstName}},

Welcome to MeetFlow. Confirm your email address to finish setting up your account:

{{verificationUrl}}

This link expires in 24 hours. If you did not create a MeetFlow account, you can ignore this message.

— MeetFlow`,
  },
  PASSWORD_RESET: {
    subject: 'Reset your MeetFlow password',
    bodyText: `Hi {{firstName}},

We received a request to reset your MeetFlow password. Choose a new one here:

{{resetUrl}}

This link expires in 1 hour. If you did not request a reset, you can safely ignore this message — your password has not changed.

— MeetFlow`,
  },
} as const;

/** Escapes the five characters that matter when interpolating into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(payload: Record<string, unknown>, path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      payload,
    );
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Replaces `{{path}}` placeholders.
 *
 * Deliberately not a general template engine: notification bodies are partly
 * author-controlled, and a real engine would turn "edit your confirmation
 * email" into arbitrary code execution.
 */
export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
  options: { html?: boolean } = {},
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(payload, path);
    return options.html ? escapeHtml(value) : value;
  });
}

/** Minimal, readable HTML wrapper around a rendered plain-text body. */
export function textToHtml(text: string, payload: Record<string, unknown>): string {
  const escaped = renderTemplate(text, payload, { html: true })
    .split('\n')
    .map((line) => (line.trim() === '' ? '<br/>' : `<p style="margin:0 0 8px">${line}</p>`))
    .join('');
  return `<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#111827;max-width:560px">${escaped}</div>`;
}
