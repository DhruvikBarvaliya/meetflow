/**
 * Declarative "when X happens, do Y" rule owned by one workspace.
 *
 * `conditions` and `actions` are JSONB rather than child tables because they are
 * only ever read as a whole when the rule fires, and their shapes evolve with
 * each new action type. Every run is recorded as an AutomationExecution, so the
 * rule row itself never has to carry history.
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

export const AUTOMATION_TRIGGER_EVENTS = [
  'appointment.created',
  'appointment.confirmed',
  'appointment.cancelled',
  'appointment.rescheduled',
  'appointment.completed',
  'appointment.no_show',
  'appointment.approaching',
  'waitlist.slot_available',
  'customer.created',
] as const;
export type AutomationTriggerEvent = (typeof AUTOMATION_TRIGGER_EVENTS)[number];

export class AutomationRule extends Model<
  InferAttributes<AutomationRule>,
  InferCreationAttributes<AutomationRule>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare name: string;
  declare description: string | null;
  declare triggerEvent: AutomationTriggerEvent;
  /** `[{ field, operator, value }]` — every entry must match (AND). */
  declare conditions: CreationOptional<Record<string, unknown>[]>;
  /** `[{ type: 'SEND_NOTIFICATION' | 'CREATE_TASK' | ..., ...params }]` */
  declare actions: CreationOptional<Record<string, unknown>[]>;
  declare delayMinutes: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare runCount: CreationOptional<number>;
  declare lastRunAt: Date | null;
  declare createdByUserId: ForeignKey<string> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * Zero delay means the actions run in the trigger's own dispatch; anything
   * else has to become a delayed job, so the dispatcher branches on this.
   */
  get runsImmediately(): NonAttribute<boolean> {
    return this.delayMinutes === 0;
  }

  /** An empty condition list matches every occurrence of the trigger. */
  get matchesEveryEvent(): NonAttribute<boolean> {
    return this.conditions.length === 0;
  }
}

AutomationRule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    triggerEvent: { type: DataTypes.TEXT, allowNull: false },
    conditions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    actions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    delayMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    runCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastRunAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'AutomationRule',
    tableName: 'automation_rules',
    underscored: true,
    // Paranoid: `automation_rules_trigger_idx` is filtered to `deleted_at IS
    // NULL`, and past executions must keep pointing at the rule that produced
    // them when an owner removes it.
    paranoid: true,
    scopes: {
      /** The dispatcher's lookup, mirroring `automation_rules_trigger_idx`. */
      active: { where: { isActive: true } },
    },
  },
);
