/**
 * Durable record of an idempotent request and the response it produced.
 *
 * Stored in PostgreSQL rather than Redis alone so a replay is still recognised
 * after a cache flush: the unique index on (scope, key) is what makes the very
 * first insert the winner, and every later attempt reads this row instead of
 * re-running the operation.
 *
 * `resourceType`/`resourceId` are a deliberate polymorphic pair with no foreign
 * key — the record outlives whatever it points at, and a cascade from the
 * target table would destroy the proof that the request was already handled.
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

export const IDEMPOTENCY_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'FAILED'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export class IdempotencyKey extends Model<
  InferAttributes<IdempotencyKey>,
  InferCreationAttributes<IdempotencyKey>
> {
  declare id: CreationOptional<string>;
  declare scope: string;
  declare key: string;
  declare businessId: ForeignKey<string> | null;
  declare requestHash: string;
  declare status: CreationOptional<IdempotencyStatus>;
  declare responseStatus: number | null;
  declare responseBody: Record<string, unknown> | null;
  declare resourceType: string | null;
  declare resourceId: string | null;
  declare lockedAt: CreationOptional<Date>;
  declare completedAt: Date | null;
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** Past this point the sweeper may delete the row and the key is reusable. */
  get isExpired(): NonAttribute<boolean> {
    return this.expiresAt.getTime() <= Date.now();
  }

  /** A stored response exists, so the replay can be answered without work. */
  get isReplayable(): NonAttribute<boolean> {
    return this.status === 'COMPLETED' && this.responseStatus !== null;
  }
}

IdempotencyKey.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    scope: { type: DataTypes.TEXT, allowNull: false },
    key: { type: DataTypes.TEXT, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: true },
    requestHash: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'IN_PROGRESS' },
    responseStatus: { type: DataTypes.INTEGER, allowNull: true },
    responseBody: { type: DataTypes.JSONB, allowNull: true },
    resourceType: { type: DataTypes.TEXT, allowNull: true },
    resourceId: { type: DataTypes.UUID, allowNull: true },
    lockedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'IdempotencyKey',
    tableName: 'idempotency_keys',
    underscored: true,
    // Not paranoid: expired keys are hard-deleted by the sweeper, and a
    // soft-deleted row would keep occupying the unique (scope, key) slot.
    paranoid: false,
  },
);
