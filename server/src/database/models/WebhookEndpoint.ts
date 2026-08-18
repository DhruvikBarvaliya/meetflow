/**
 * A customer-registered HTTP destination for outbound events.
 *
 * `failureCount` counts *consecutive* failures and is reset by the first
 * success; once it crosses the delivery worker's threshold the endpoint is
 * disabled (`isActive` false, `disabledAt` set) so a dead subscriber server
 * cannot drain the worker pool indefinitely.
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

/** Subscribing to this event name delivers every event the platform emits. */
export const WEBHOOK_WILDCARD_EVENT = '*';

export class WebhookEndpoint extends Model<
  InferAttributes<WebhookEndpoint>,
  InferCreationAttributes<WebhookEndpoint>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare url: string;
  declare description: string | null;
  /** Event names this endpoint subscribes to; `'*'` subscribes to all. */
  declare events: CreationOptional<string[]>;
  /**
   * Key for the HMAC-SHA256 signature header. Returned to the caller exactly
   * once, at creation — hence the default scope that keeps it out of reads.
   */
  declare signingSecret: string;
  declare isActive: CreationOptional<boolean>;
  declare failureCount: CreationOptional<number>;
  declare disabledAt: Date | null;
  declare lastSuccessAt: Date | null;
  declare lastFailureAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * The wildcard makes subscription matching more than an array membership
   * test, so every fan-out decision goes through this one implementation.
   */
  subscribesTo(event: string): NonAttribute<boolean> {
    return this.events.includes(WEBHOOK_WILDCARD_EVENT) || this.events.includes(event);
  }
}

WebhookEndpoint.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    url: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    events: {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: false,
      defaultValue: [WEBHOOK_WILDCARD_EVENT],
    },
    signingSecret: { type: DataTypes.TEXT, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    disabledAt: { type: DataTypes.DATE, allowNull: true },
    lastSuccessAt: { type: DataTypes.DATE, allowNull: true },
    lastFailureAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'WebhookEndpoint',
    tableName: 'webhook_endpoints',
    underscored: true,
    paranoid: true,
    // The signing secret is excluded from every query unless a scope explicitly
    // asks for it, so a forgotten `attributes` list cannot echo it back.
    defaultScope: {
      attributes: { exclude: ['signingSecret'] },
    },
    scopes: {
      // `WebhookEndpoint.scope('withSecret')` replaces defaultScope entirely, so
      // an empty scope is what restores the column. The delivery signer is the
      // only caller.
      withSecret: {},
    },
  },
);
