/**
 * Renderable content for one (key, channel, locale) message.
 *
 * A NULL `businessId` is a built-in MeetFlow default; a workspace row with the
 * same key/channel/locale shadows it. Resolution is therefore always "tenant row
 * first, system row as fallback" — the two partial unique indexes in the
 * migration guarantee at most one candidate on each side.
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

export const NOTIFICATION_TEMPLATE_KEYS = [
  'BOOKING_CONFIRMATION',
  'BOOKING_PENDING_APPROVAL',
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'BOOKING_CANCELLED',
  'BOOKING_RESCHEDULED',
  'APPOINTMENT_REMINDER',
  'APPOINTMENT_FOLLOW_UP',
  'APPOINTMENT_NO_SHOW',
  'WAITLIST_SLOT_AVAILABLE',
  'WAITLIST_CONFIRMED',
  'STAFF_ASSIGNED',
  'STAFF_SCHEDULE_CHANGED',
  'OWNER_DAILY_DIGEST',
  'OWNER_NEW_BOOKING',
  'CUSTOMER_WELCOME',
] as const;
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

export const NOTIFICATION_TEMPLATE_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationTemplateChannel = (typeof NOTIFICATION_TEMPLATE_CHANNELS)[number];

export class NotificationTemplate extends Model<
  InferAttributes<NotificationTemplate>,
  InferCreationAttributes<NotificationTemplate>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string> | null;
  declare key: NotificationTemplateKey;
  declare channel: NotificationTemplateChannel;
  declare locale: CreationOptional<string>;
  /** Null for SMS and IN_APP, which have no subject line to render. */
  declare subject: string | null;
  declare bodyText: string;
  declare bodyHtml: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** A system row may be read by every tenant but edited by none of them. */
  get isSystemDefault(): NonAttribute<boolean> {
    return this.businessId === null;
  }
}

NotificationTemplate.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: true },
    key: { type: DataTypes.TEXT, allowNull: false },
    channel: { type: DataTypes.TEXT, allowNull: false },
    locale: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'en-US' },
    subject: { type: DataTypes.TEXT, allowNull: true },
    bodyText: { type: DataTypes.TEXT, allowNull: false },
    bodyHtml: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'NotificationTemplate',
    tableName: 'notification_templates',
    underscored: true,
    // Not paranoid: a retired template is deactivated, because deleting it would
    // silently fall back to the system default mid-campaign.
    paranoid: false,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
