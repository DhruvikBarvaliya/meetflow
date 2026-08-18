/**
 * A named bundle of permissions inside one workspace.
 *
 * `businessId` is nullable on purpose: a NULL row is a built-in system template
 * that every new workspace is cloned from at creation time. Partial unique
 * indexes keep one key per workspace and one global template per key, so the two
 * populations never collide.
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

export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string> | null;
  /** Stable machine identifier, constrained to `^[A-Z][A-Z0-9_]*$` by the column. */
  declare key: string;
  declare name: string;
  declare description: string | null;
  declare isSystem: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * True for the global templates. Distinct from `isSystem`, which also marks
   * the per-workspace clones that the API must refuse to rename or delete.
   */
  get isTemplate(): NonAttribute<boolean> {
    return this.businessId === null;
  }
}

Role.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: true },
    key: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Role',
    tableName: 'roles',
    underscored: true,
    // Not paranoid: memberships reference roles ON DELETE RESTRICT, so a role in
    // use cannot be removed at all and a soft-deleted one would be unreachable.
    paranoid: false,
  },
);
