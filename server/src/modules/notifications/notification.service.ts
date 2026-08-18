/**
 * Notification outbox.
 *
 * Nothing here sends an email. Every function writes a durable `notifications`
 * row — inside the caller's transaction when there is one — and asks the queue
 * to deliver it. That ordering is the whole point:
 *
 *   - a booking that rolls back never sends a confirmation, because the
 *     notification row rolls back with it;
 *   - a booking that commits always sends one, because a periodic sweep picks
 *     up any row whose enqueue was lost.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { Notification, NotificationTemplate } from '../../database/models';
import { JOB_NAMES, notificationQueue, safeEnqueue } from '../../jobs/queues';
import { sha256 } from '../../utils/ids';
import {
  DEFAULT_TEMPLATES,
  SYSTEM_TEMPLATES,
  renderTemplate,
  textToHtml,
  type TemplateKey,
} from './templates';

const log = createLogger('notifications');

export interface EnqueueInput {
  businessId?: string | null;
  type: TemplateKey | 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  channel?: 'EMAIL' | 'SMS' | 'IN_APP';
  recipientType: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'ADMIN';
  recipientCustomerId?: string | null;
  recipientUserId?: string | null;
  recipientAddress: string;
  appointmentId?: string | null;
  waitlistEntryId?: string | null;
  payload: Record<string, unknown>;
  /** Future instant turns this into a reminder. Defaults to "now". */
  scheduledFor?: Date;
  /**
   * Stable natural key. Two enqueues with the same value produce one row, which
   * is what stops a retried job or a double-clicked button sending twice.
   */
  dedupeKey?: string;
  subject?: string;
  body?: string;
}

/**
 * Resolves the template for a workspace, preferring a workspace override over
 * the built-in default.
 */
async function resolveTemplate(
  businessId: string | null | undefined,
  key: TemplateKey,
  channel: 'EMAIL' | 'SMS' | 'IN_APP',
  locale = 'en-US',
): Promise<{ subject: string; bodyText: string }> {
  if (businessId) {
    const override = await NotificationTemplate.findOne({
      where: { businessId, key, channel, locale, isActive: true },
    });
    if (override) {
      return { subject: override.subject ?? '', bodyText: override.bodyText };
    }
  }

  const systemRow = await NotificationTemplate.findOne({
    where: { businessId: { [Op.is]: null }, key, channel, locale, isActive: true },
  });
  if (systemRow) {
    return { subject: systemRow.subject ?? '', bodyText: systemRow.bodyText };
  }

  const builtIn = DEFAULT_TEMPLATES.find((item) => item.key === key && item.channel === channel);
  if (!builtIn) {
    throw new Error(`No template defined for ${key}/${channel}`);
  }
  return { subject: builtIn.subject, bodyText: builtIn.bodyText };
}

/**
 * Writes one outbox row and schedules delivery.
 *
 * Returns null when the dedupe key already exists — a duplicate is a success
 * from the caller's point of view, not an error.
 */
export async function enqueueNotification(
  input: EnqueueInput,
  options: { transaction?: Transaction } = {},
): Promise<Notification | null> {
  const channel = input.channel ?? 'EMAIL';
  const scheduledFor = input.scheduledFor ?? new Date();

  let subject = input.subject;
  let body = input.body;

  if (!subject || !body) {
    if (input.type === 'EMAIL_VERIFICATION' || input.type === 'PASSWORD_RESET') {
      const system = SYSTEM_TEMPLATES[input.type];
      subject ??= renderTemplate(system.subject, input.payload);
      body ??= renderTemplate(system.bodyText, input.payload);
    } else {
      const template = await resolveTemplate(input.businessId, input.type, channel);
      subject ??= renderTemplate(template.subject, input.payload);
      body ??= renderTemplate(template.bodyText, input.payload);
    }
  }

  const values = {
    businessId: input.businessId ?? null,
    type: input.type,
    channel,
    recipientType: input.recipientType,
    recipientCustomerId: input.recipientCustomerId ?? null,
    recipientUserId: input.recipientUserId ?? null,
    recipientAddress: input.recipientAddress,
    appointmentId: input.appointmentId ?? null,
    waitlistEntryId: input.waitlistEntryId ?? null,
    subject,
    body,
    payload: input.payload,
    scheduledFor,
    sentAt: null,
    failedAt: null,
    lastError: null,
    providerMessageId: null,
    dedupeKey: input.dedupeKey ?? null,
  };

  let row: Notification;
  try {
    // The unique index on dedupe_key is what makes this idempotent. Inside a
    // caller's transaction the INSERT must run in a SAVEPOINT: in PostgreSQL a
    // failed statement aborts the whole transaction, so catching the duplicate
    // without a savepoint would silently discard the caller's booking.
    row = options.transaction
      ? await sequelize.transaction({ transaction: options.transaction }, async (savepoint) =>
          Notification.create(values, { transaction: savepoint }),
        )
      : await Notification.create(values);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SequelizeUniqueConstraintError' &&
      input.dedupeKey
    ) {
      log.debug({ dedupeKey: input.dedupeKey }, 'notification already queued — skipping duplicate');
      return null;
    }
    throw error;
  }

  const delay = Math.max(0, scheduledFor.getTime() - Date.now());
  const schedule = () =>
    void safeEnqueue(
      notificationQueue,
      JOB_NAMES.deliverNotification,
      { notificationId: row.id },
      // jobId keyed on the row: a re-enqueue from the sweep cannot create a
      // second delivery job for the same notification.
      { delay, jobId: `notification:${row.id}` },
    );

  if (options.transaction) {
    // Only schedule once the row is actually committed and visible to the
    // worker — otherwise the job can win the race and find nothing.
    options.transaction.afterCommit(schedule);
  } else {
    schedule();
  }

  return row;
}

// ---------------------------------------------------------------------------
// Account emails
// ---------------------------------------------------------------------------

export async function enqueueEmailVerification(input: {
  userId: string;
  email: string;
  firstName: string;
  token: string;
}): Promise<void> {
  await enqueueNotification({
    type: 'EMAIL_VERIFICATION',
    recipientType: 'ADMIN',
    recipientUserId: input.userId,
    recipientAddress: input.email,
    payload: {
      firstName: input.firstName,
      verificationUrl: `${env.PUBLIC_APP_URL}/verify-email?token=${encodeURIComponent(input.token)}`,
    },
    // One verification email per issued token, even if the request is retried.
    dedupeKey: `verify:${sha256(input.token)}`,
  });
}

export async function enqueuePasswordReset(input: {
  userId: string;
  email: string;
  firstName: string;
  token: string;
}): Promise<void> {
  await enqueueNotification({
    type: 'PASSWORD_RESET',
    recipientType: 'ADMIN',
    recipientUserId: input.userId,
    recipientAddress: input.email,
    payload: {
      firstName: input.firstName,
      resetUrl: `${env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(input.token)}`,
    },
    dedupeKey: `reset:${sha256(input.token)}`,
  });
}

/** Renders the HTML body at delivery time, from the stored plain-text body. */
export function buildHtmlBody(body: string, payload: Record<string, unknown>): string {
  return textToHtml(body, payload);
}
