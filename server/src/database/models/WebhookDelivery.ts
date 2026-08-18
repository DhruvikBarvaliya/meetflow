/**
 * One queued or completed attempt-set for delivering a single event to a single
 * endpoint.
 *
 * `businessId` is carried alongside `endpointId` so a tenant's delivery log can
 * be authorised and filtered without joining back to webhook_endpoints — the
 * endpoint's own tenant column remains the source of truth. `eventId` is stable
 * across endpoints and is echoed in the payload so consumers can dedupe; paired
 * with `endpointId` it is unique, which is what makes enqueueing idempotent.
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

export const WEBHOOK_DELIVERY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Statuses from which no further attempt will ever be made. */
export const TERMINAL_WEBHOOK_DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = [
  'DELIVERED',
  'FAILED',
  'CANCELLED',
];

export class WebhookDelivery extends Model<
  InferAttributes<WebhookDelivery>,
  InferCreationAttributes<WebhookDelivery>
> {
  declare id: CreationOptional<string>;
  declare endpointId: ForeignKey<string>;
  declare businessId: ForeignKey<string>;
  /**
   * Identifies the source event, not a row in any table, so it carries no
   * foreign key: one event fans out to every subscribed endpoint.
   */
  declare eventId: string;
  declare event: string;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<WebhookDeliveryStatus>;
  declare attemptCount: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare responseStatus: number | null;
  /** Truncated by the worker; a verbose endpoint must not bloat the table. */
  declare responseBody: string | null;
  declare error: string | null;
  /** Moved forward by the worker's backoff after each failed attempt. */
  declare scheduledFor: CreationOptional<Date>;
  declare deliveredAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  get isTerminal(): NonAttribute<boolean> {
    return TERMINAL_WEBHOOK_DELIVERY_STATUSES.includes(this.status);
  }

  /** False is what turns the next failure into a permanent FAILED. */
  get hasAttemptsRemaining(): NonAttribute<boolean> {
    return this.attemptCount < this.maxAttempts;
  }

  get isDue(): NonAttribute<boolean> {
    return this.status === 'PENDING' && this.scheduledFor.getTime() <= Date.now();
  }
}

WebhookDelivery.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    endpointId: { type: DataTypes.UUID, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    eventId: { type: DataTypes.UUID, allowNull: false },
    event: { type: DataTypes.TEXT, allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PENDING' },
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 6 },
    responseStatus: { type: DataTypes.INTEGER, allowNull: true },
    responseBody: { type: DataTypes.TEXT, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    scheduledFor: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'WebhookDelivery',
    tableName: 'webhook_deliveries',
    underscored: true,
    // Not paranoid: CANCELLED is a real lifecycle state, and old deliveries are
    // hard-deleted by the retention job rather than hidden.
    paranoid: false,
  },
);
