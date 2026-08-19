/**
 * Workspace overrides for the messages MeetFlow sends.
 *
 * `resolveTemplate` in `notification.service.ts` has always looked for a
 * workspace row before falling back to the built-in default. Nothing ever wrote
 * one — no seeder, no route — so the first branch of that lookup was dead in
 * every environment and `templates:manage` was a permission the built-in roles
 * granted to owners and managers while guarding nothing. This module is the
 * other half.
 *
 * Three rules shape it:
 *
 *  1. **A default is never a row.** The built-ins live in `templates.ts` and
 *     stay there. Copying all sixteen into every workspace at creation time
 *     would freeze each one at the version that shipped that day — an
 *     improvement to the confirmation email would then reach nobody who signed
 *     up before it. A workspace has a row only where somebody deliberately
 *     wrote one, and deleting that row restores the living default rather than
 *     an old copy of it.
 *
 *  2. **A placeholder that cannot be filled is refused.** `renderTemplate`
 *     substitutes an unknown name with an empty string, so `{{cusotmerName}}`
 *     ships an email opening "Hi ," to every customer with nothing logged. The
 *     catalogue in `placeholders.ts` is checked on save and the refusal names
 *     the offending placeholder — this is the single most valuable thing the
 *     endpoint does, and the reason it is worth more than a text column.
 *
 *  3. **The workspace supplies text, never markup.** The HTML part is generated
 *     from the text by `textToHtml`, which escapes every interpolated value.
 *     Accepting tenant-authored HTML would put unescaped markup inside a message
 *     sent from MeetFlow's own sending domain.
 */
import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import { NotificationTemplate } from '../../database/models';
import type {
  NotificationTemplateChannel,
  NotificationTemplateKey,
} from '../../database/models/NotificationTemplate';
import {
  NOTIFICATION_TEMPLATE_CHANNELS,
  NOTIFICATION_TEMPLATE_KEYS,
} from '../../database/models/NotificationTemplate';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  PLACEHOLDER_DESCRIPTIONS,
  PREVIEW_SAMPLE,
  TEMPLATE_PLACEHOLDERS,
  unknownPlaceholders,
} from './placeholders';
import { DEFAULT_TEMPLATES, renderTemplate, textToHtml } from './templates';
import type { PreviewTemplateBody, UpsertTemplateBody } from './templates.validation';

const log = createLogger('notification-templates');

/** The default locale. The table is keyed on it; nothing varies it yet. */
const LOCALE = 'en-US';

export interface TemplateActor {
  userId: string;
  email: string;
}

/**
 * Where the copy a customer receives is coming from right now.
 *
 * The distinction is the point of the screen: an operator needs to know at a
 * glance which messages they have taken ownership of and which are still
 * following MeetFlow's, because the second group changes under them when the
 * defaults improve and the first group does not.
 */
export type TemplateSource = 'WORKSPACE' | 'BUILT_IN';

export interface TemplateView {
  key: NotificationTemplateKey;
  channel: NotificationTemplateChannel;
  locale: string;
  /** What will actually be sent. */
  subject: string | null;
  bodyText: string;
  source: TemplateSource;
  /** Present only for a workspace override that has been switched off. */
  isActive: boolean;
  /** MeetFlow's own copy, always — so the editor can offer "restore default". */
  defaultSubject: string | null;
  defaultBodyText: string | null;
  /** The names this message can fill, with one line of help each. */
  placeholders: Array<{ name: string; description: string }>;
  updatedAt: Date | null;
}

function builtIn(key: NotificationTemplateKey, channel: NotificationTemplateChannel) {
  return DEFAULT_TEMPLATES.find((item) => item.key === key && item.channel === channel) ?? null;
}

function placeholdersFor(
  key: NotificationTemplateKey,
): Array<{ name: string; description: string }> {
  return TEMPLATE_PLACEHOLDERS[key].map((name) => ({
    name,
    description: PLACEHOLDER_DESCRIPTIONS[name] ?? '',
  }));
}

function toView(
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  override: NotificationTemplate | null,
): TemplateView {
  const fallback = builtIn(key, channel);
  // An override that exists but is switched off is shown as what it is: the row
  // is still theirs, but the default is what customers are receiving.
  const live = override?.isActive === true;

  return {
    key,
    channel,
    locale: LOCALE,
    subject: live ? override.subject : (fallback?.subject ?? null),
    bodyText: live ? override.bodyText : (fallback?.bodyText ?? ''),
    source: live ? 'WORKSPACE' : 'BUILT_IN',
    isActive: override?.isActive ?? false,
    defaultSubject: fallback?.subject ?? null,
    defaultBodyText: fallback?.bodyText ?? null,
    placeholders: placeholdersFor(key),
    updatedAt: override?.updatedAt ?? null,
  };
}

/**
 * Every message the workspace can rewrite, with what it is sending today.
 *
 * Driven from the built-in catalogue rather than from the table, because the
 * table is empty for a workspace that has never edited anything and a screen
 * that listed its rows would be blank on exactly the visit where the operator
 * most needs to see what is being sent in their name.
 */
export async function listTemplates(
  businessId: string,
  filters: { channel?: NotificationTemplateChannel } = {},
): Promise<TemplateView[]> {
  const overrides = await NotificationTemplate.findAll({
    where: { businessId, locale: LOCALE },
  });
  const byAddress = new Map(overrides.map((row) => [`${row.key}:${row.channel}`, row] as const));

  const views: TemplateView[] = [];
  for (const key of NOTIFICATION_TEMPLATE_KEYS) {
    for (const channel of NOTIFICATION_TEMPLATE_CHANNELS) {
      if (filters.channel && channel !== filters.channel) continue;
      // Only pairs MeetFlow actually defines. There is no SMS confirmation to
      // rewrite, and offering an empty editor for one would promise a message
      // that no producer sends.
      if (!builtIn(key, channel)) continue;
      views.push(toView(key, channel, byAddress.get(`${key}:${channel}`) ?? null));
    }
  }
  return views;
}

export async function getTemplate(
  businessId: string,
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
): Promise<TemplateView> {
  if (!builtIn(key, channel)) {
    throw new NotFoundError('Message template');
  }
  const override = await NotificationTemplate.findOne({
    where: { businessId, key, channel, locale: LOCALE },
  });
  return toView(key, channel, override);
}

/**
 * Refuses a body that names something the message cannot fill.
 *
 * The refusal lists what *is* available rather than only what is wrong: an
 * operator who mistyped `{{customerName}}` is one glance from the right
 * spelling, and an operator who invented `{{invoiceTotal}}` learns immediately
 * that there is no such thing rather than discovering it from a customer.
 */
function assertPlaceholdersResolve(
  key: NotificationTemplateKey,
  parts: { subject?: string | null; bodyText: string },
): void {
  const offenders = [
    ...unknownPlaceholders(key, parts.subject ?? ''),
    ...unknownPlaceholders(key, parts.bodyText),
  ];
  if (offenders.length === 0) return;

  const unique = [...new Set(offenders)];
  throw new ValidationError(
    `This message cannot fill ${unique.map((name) => `{{${name}}}`).join(', ')}. ` +
      `It would be sent as empty text. Available here: ${TEMPLATE_PLACEHOLDERS[key]
        .map((name) => `{{${name}}}`)
        .join(', ')}.`,
    unique.map((name) => ({
      field: 'bodyText',
      message: `{{${name}}} is not available on ${key} messages.`,
    })),
  );
}

/**
 * Creates or replaces the workspace's version of one message.
 *
 * `upsert` rather than find-then-write: the table's partial unique index on
 * (business_id, key, channel, locale) is what makes two operators saving the
 * same template at once produce one row instead of a constraint violation
 * surfaced as a 500.
 */
export async function upsertTemplate(
  businessId: string,
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  input: UpsertTemplateBody,
  actor: TemplateActor,
  metadata: RequestMetadata,
): Promise<TemplateView> {
  const fallback = builtIn(key, channel);
  if (!fallback) throw new NotFoundError('Message template');

  // An email with no subject line is not a message an operator meant to send;
  // every spam filter reads a blank one exactly as it looks.
  if (channel === 'EMAIL' && !input.subject) {
    throw new ValidationError('An email template needs a subject line.', [
      { field: 'subject', message: 'Required for email templates.' },
    ]);
  }

  assertPlaceholdersResolve(key, input);

  const values = {
    subject: channel === 'EMAIL' ? (input.subject ?? null) : null,
    bodyText: input.bodyText,
    // Generated, never accepted: see rule 3 in the header.
    bodyHtml: null,
    isActive: input.isActive ?? true,
  };

  // Not `Model.upsert`. Sequelize compiles that to
  // `ON CONFLICT (business_id, key, channel, locale) DO UPDATE`, and the index
  // backing those columns is *partial* — `WHERE business_id IS NOT NULL`, so
  // that a system row and a workspace row can coexist. PostgreSQL cannot infer
  // a partial index from a bare column list and answers "no unique or exclusion
  // constraint matching the ON CONFLICT specification", which would make every
  // save a 500. Insert first, and let the index arbitrate the race: the loser
  // gets a unique violation and updates the row the winner just wrote.
  const row = await sequelize
    .transaction(async (transaction) => {
      const existing = await NotificationTemplate.findOne({
        where: { businessId, key, channel, locale: LOCALE },
        transaction,
      });
      if (existing) {
        await existing.update(values, { transaction });
        return existing;
      }
      return NotificationTemplate.create(
        { businessId, key, channel, locale: LOCALE, ...values },
        { transaction },
      );
    })
    .catch(async (error: unknown) => {
      if (!(error instanceof UniqueConstraintError)) throw error;
      // Two operators saved the same template at the same instant. The index did
      // its job; the second write is still the operator's intent, so apply it.
      const winner = await NotificationTemplate.findOne({
        where: { businessId, key, channel, locale: LOCALE },
      });
      if (!winner) throw error;
      await winner.update(values);
      return winner;
    });

  await recordAudit({
    businessId,
    actorType: 'USER',
    actorUserId: actor.userId,
    actorLabel: actor.email,
    action: AuditActions.NOTIFICATION_TEMPLATE_UPDATED,
    entityType: 'notification_template',
    entityId: row.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
    // The copy itself is not recorded — an audit log is not a revision history,
    // and message bodies routinely quote a customer's own words back at them.
    metadata: {
      key,
      channel,
      isActive: row.isActive,
      matchesDefault: row.bodyText === fallback.bodyText,
    },
  });

  log.info({ businessId, key, channel }, 'notification template overridden');
  return toView(key, channel, row);
}

/**
 * Drops the workspace's version, restoring MeetFlow's.
 *
 * Restores the *living* default, not a snapshot: the row goes away entirely, so
 * the next send reads `DEFAULT_TEMPLATES` and picks up every improvement made
 * to it since. That is the whole reason defaults are not copied into a
 * workspace at creation time.
 */
export async function resetTemplate(
  businessId: string,
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  actor: TemplateActor,
  metadata: RequestMetadata,
): Promise<void> {
  const row = await NotificationTemplate.findOne({
    where: { businessId, key, channel, locale: LOCALE },
  });
  // 404, not 204: a workspace that never overrode this message has nothing to
  // reset, and answering 204 would tell an operator their edit was undone when
  // there was no edit.
  if (!row) throw new NotFoundError('Message template override');

  await row.destroy();

  await recordAudit({
    businessId,
    actorType: 'USER',
    actorUserId: actor.userId,
    actorLabel: actor.email,
    action: AuditActions.NOTIFICATION_TEMPLATE_RESET,
    entityType: 'notification_template',
    entityId: row.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
    metadata: { key, channel },
  });

  log.info({ businessId, key, channel }, 'notification template reset to the built-in default');
}

export interface TemplatePreview {
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  /** Named so the editor can highlight what it substituted. */
  placeholdersUsed: string[];
}

/**
 * Renders a draft against believable sample data.
 *
 * Takes the draft from the request rather than the saved row, because the
 * question an operator is asking is "should I save this", and answering it only
 * after they save is answering it too late. The same validation runs, so a
 * preview cannot show a template the save would refuse.
 */
export function previewTemplate(
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  input: PreviewTemplateBody,
): TemplatePreview {
  if (!builtIn(key, channel)) throw new NotFoundError('Message template');
  assertPlaceholdersResolve(key, input);

  const sample = PREVIEW_SAMPLE;
  return {
    subject: input.subject ? renderTemplate(input.subject, sample) : null,
    bodyText: renderTemplate(input.bodyText, sample),
    // Only email has an HTML part; rendering one for SMS would preview
    // something the recipient will never see.
    bodyHtml: channel === 'EMAIL' ? textToHtml(input.bodyText, sample) : null,
    placeholdersUsed: TEMPLATE_PLACEHOLDERS[key].filter((name) =>
      new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(`${input.subject ?? ''}\n${input.bodyText}`),
    ),
  };
}
