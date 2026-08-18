/**
 * Append-only audit trail.
 *
 * Nothing in the application updates or deletes a row: an entry is the record of
 * what was believed at the moment it was written. `actorLabel`, `entityType` and
 * `entityId` are deliberately denormalised snapshots rather than joins, so the
 * trail still reads correctly after the user, customer or entity it describes
 * has been deleted.
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

export const AUDIT_ACTOR_TYPES = ['USER', 'CUSTOMER', 'SYSTEM', 'PUBLIC', 'API'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<string>;
  /** NULL for platform-level events that belong to no single tenant. */
  declare businessId: ForeignKey<string> | null;
  declare actorType: CreationOptional<AuditActorType>;
  declare actorUserId: ForeignKey<string> | null;
  declare actorCustomerId: ForeignKey<string> | null;
  /**
   * Human-readable actor snapshot ("Priya Shah <priya@…>"), kept because both
   * actor foreign keys null out when the account behind them is deleted.
   */
  declare actorLabel: string | null;
  /** Dotted verb, e.g. 'appointment.cancelled', 'role.permissions_changed'. */
  declare action: string;
  declare entityType: string;
  /**
   * Polymorphic across every audited table, so it carries no foreign key and is
   * not typed as one.
   */
  declare entityId: string | null;
  /** Correlates the entry with the HTTP request and its application logs. */
  declare requestId: string | null;
  declare ipAddress: string | null;
  declare userAgent: string | null;
  /** Safe, non-sensitive context only: never tokens, hashes or passwords. */
  declare metadata: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;

  /** Platform-wide events are the ones no tenant feed may ever surface. */
  get isPlatformEvent(): NonAttribute<boolean> {
    return this.businessId === null;
  }
}

AuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: true },
    actorType: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'SYSTEM' },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    actorCustomerId: { type: DataTypes.UUID, allowNull: true },
    actorLabel: { type: DataTypes.TEXT, allowNull: true },
    action: { type: DataTypes.TEXT, allowNull: false },
    entityType: { type: DataTypes.TEXT, allowNull: false },
    entityId: { type: DataTypes.UUID, allowNull: true },
    requestId: { type: DataTypes.TEXT, allowNull: true },
    ipAddress: { type: DataTypes.INET, allowNull: true },
    userAgent: { type: DataTypes.TEXT, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AuditLog',
    tableName: 'audit_logs',
    underscored: true,
    // The table is immutable, so it has no updated_at column; Sequelize must be
    // told not to write one.
    updatedAt: false,
    // Not paranoid: an audit trail is never deleted, softly or otherwise.
    paranoid: false,
  },
);
