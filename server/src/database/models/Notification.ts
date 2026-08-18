/**
 * Durable transactional outbox row for one outbound message.
 *
 * The row is inserted in the same transaction as the business change that
 * caused it, and the delivery worker picks it up afterwards — so a rolled-back
 * booking can never send an email, and a committed booking never loses its
 * confirmation because the queue was unavailable.
 *
 * A reminder is not a separate concept: it is a notification whose
 * `scheduledFor` lies in the future.
 *
 * Exactly one of `recipientCustomerId` / `recipientUserId` identifies who is
 * being written to (the database enforces "at least one" via
 * `notifications_recipient_check`), while `recipientAddress` records where the
 * message was actually sent.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../../config/database';

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_RECIPIENT_TYPES = ['CUSTOMER', 'STAFF', 'OWNER', 'ADMIN'] as const;
export type NotificationRecipientType = (typeof NOTIFICATION_RECIPIENT_TYPES)[number];

export const NOTIFICATION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
  'CANCELLED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export class Notification extends Model<
  InferAttributes<Notification>,
  InferCreationAttributes<Notification>
> {
  declare id: CreationOptional<string>;
  /** Null for platform-level mail that belongs to no workspace. */
  declare businessId: ForeignKey<string> | null;
  /**
   * Free-form event name, deliberately without a CHECK: the template key space
   * evolves faster than the outbox, and an unknown type must degrade to an
   * undelivered row rather than to a failed INSERT on the business transaction.
   */
  declare type: string;
  declare channel: NotificationChannel;
  declare recipientType: NotificationRecipientType;
  declare recipientCustomerId: ForeignKey<string> | null;
  declare recipientUserId: ForeignKey<string> | null;
  /**
   * Destination snapshotted at enqueue time. If the recipient later edits their
   * email or phone, an in-flight message still went where it was addressed and
   * the audit trail stays truthful.
   */
  declare recipientAddress: string;
  declare appointmentId: ForeignKey<string> | null;
  declare waitlistEntryId: ForeignKey<string> | null;
  /** Rendered content; both stay null until the worker resolves the template. */
  declare subject: string | null;
  declare body: string | null;
  /** Template variables, kept so a message can be re-rendered after a fix. */
  declare payload: CreationOptional<Record<string, unknown>>;
  declare status: CreationOptional<NotificationStatus>;
  declare scheduledFor: CreationOptional<Date>;
  declare sentAt: Date | null;
  declare failedAt: Date | null;
  declare attemptCount: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare lastError: string | null;
  declare providerMessageId: string | null;
  /** Job-layer idempotency: a replayed job with the same key cannot send twice. */
  declare dedupeKey: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** Exactly the rows the delivery worker is allowed to claim right now. */
  get isDue(): NonAttribute<boolean> {
    return this.status === 'PENDING' && this.scheduledFor.getTime() <= Date.now();
  }

  /**
   * Whether a failure is worth another attempt. Comparing against the row's own
   * `maxAttempts` keeps a per-message override meaningful instead of hardcoding
   * the retry budget in the worker.
   */
  get canRetry(): NonAttribute<boolean> {
    return this.attemptCount < this.maxAttempts;
  }
}

Notification.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: true },
    type: { type: DataTypes.TEXT, allowNull: false },
    channel: { type: DataTypes.TEXT, allowNull: false },
    recipientType: { type: DataTypes.TEXT, allowNull: false },
    recipientCustomerId: { type: DataTypes.UUID, allowNull: true },
    recipientUserId: { type: DataTypes.UUID, allowNull: true },
    recipientAddress: { type: DataTypes.TEXT, allowNull: false },
    appointmentId: { type: DataTypes.UUID, allowNull: true },
    waitlistEntryId: { type: DataTypes.UUID, allowNull: true },
    subject: { type: DataTypes.TEXT, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: true },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PENDING' },
    scheduledFor: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    failedAt: { type: DataTypes.DATE, allowNull: true },
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    providerMessageId: { type: DataTypes.TEXT, allowNull: true },
    dedupeKey: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Notification',
    tableName: 'notifications',
    underscored: true,
    // Not paranoid: an outbox row is the delivery record. Withdrawing a message
    // is the CANCELLED status, which stays auditable.
    paranoid: false,
    scopes: {
      /**
       * The worker's claim order, matching `notifications_due_idx`: pending
       * first, oldest schedule first, so a backlog drains in the order it was
       * promised rather than in insertion order.
       */
      pending: {
        where: { status: 'PENDING' },
        order: [['scheduledFor', 'ASC']],
      },
    },
  },
);
