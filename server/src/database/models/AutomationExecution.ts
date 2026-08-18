/**
 * One attempt at running an AutomationRule against one triggering entity.
 *
 * This is the "why did my automation do that?" record support answers from, so
 * `triggerEvent` and `result` are written here rather than being re-derived from
 * the rule: the rule can be edited or soft-deleted afterwards and the history
 * must still describe what actually happened.
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

export const AUTOMATION_EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
] as const;
export type AutomationExecutionStatus = (typeof AUTOMATION_EXECUTION_STATUSES)[number];

export class AutomationExecution extends Model<
  InferAttributes<AutomationExecution>,
  InferCreationAttributes<AutomationExecution>
> {
  declare id: CreationOptional<string>;
  declare ruleId: ForeignKey<string>;
  /** Denormalised from the rule so tenant-scoped queries never need the join. */
  declare businessId: ForeignKey<string>;
  /**
   * Snapshot of the event that fired, unconstrained on purpose: it records
   * history, so it must survive a trigger name being retired from the rule's
   * own allowed set.
   */
  declare triggerEvent: string;
  /** Polymorphic target ('appointment', 'customer', ...) — no FK to enforce. */
  declare entityType: string;
  declare entityId: string | null;
  declare status: CreationOptional<AutomationExecutionStatus>;
  /** Per-action outcome: what ran, what it produced, what it skipped. */
  declare result: CreationOptional<Record<string, unknown>>;
  declare error: string | null;
  declare startedAt: Date | null;
  declare finishedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** Null until the run has both started and finished. */
  get durationMs(): NonAttribute<number | null> {
    if (this.startedAt === null || this.finishedAt === null) return null;
    return this.finishedAt.getTime() - this.startedAt.getTime();
  }

  /**
   * A run that will never change again. The sweeper that reclaims executions
   * stuck in RUNNING relies on this being the complete set of end states.
   */
  get isTerminal(): NonAttribute<boolean> {
    return this.status === 'SUCCEEDED' || this.status === 'FAILED' || this.status === 'SKIPPED';
  }
}

AutomationExecution.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ruleId: { type: DataTypes.UUID, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    triggerEvent: { type: DataTypes.TEXT, allowNull: false },
    entityType: { type: DataTypes.TEXT, allowNull: false },
    entityId: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PENDING' },
    result: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    error: { type: DataTypes.TEXT, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AutomationExecution',
    tableName: 'automation_executions',
    underscored: true,
    // Not paranoid: an execution is an immutable audit row, trimmed by
    // retention rather than soft-deleted.
    paranoid: false,
  },
);
