/**
 * Grant of one permission to one role.
 *
 * The join carries no effect column — presence is the grant. Denials exist only
 * as per-member overrides on MembershipPermission.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../../config/database';

export class RolePermission extends Model<
  InferAttributes<RolePermission>,
  InferCreationAttributes<RolePermission>
> {
  declare roleId: ForeignKey<string>;
  declare permissionId: ForeignKey<string>;
  declare createdAt: CreationOptional<Date>;
}

RolePermission.init(
  {
    roleId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    permissionId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'RolePermission',
    tableName: 'role_permissions',
    underscored: true,
    paranoid: false,
    // The table has no updated_at column: a grant is inserted or deleted, never
    // mutated, so Sequelize must be told not to write one.
    updatedAt: false,
  },
);
