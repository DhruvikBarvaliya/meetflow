/**
 * Per-member exception layered on top of the role's grants.
 *
 * DENY always wins over any role grant, which makes "this one staff member must
 * not see revenue" expressible without cloning an entire role. The composite key
 * allows a single effect per member and permission, so the two effects can never
 * both apply to the same pair.
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

export const PERMISSION_EFFECTS = ['GRANT', 'DENY'] as const;
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

export class MembershipPermission extends Model<
  InferAttributes<MembershipPermission>,
  InferCreationAttributes<MembershipPermission>
> {
  declare membershipId: ForeignKey<string>;
  declare permissionId: ForeignKey<string>;
  declare effect: PermissionEffect;
  declare createdAt: CreationOptional<Date>;
}

MembershipPermission.init(
  {
    membershipId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    permissionId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    effect: { type: DataTypes.TEXT, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'MembershipPermission',
    tableName: 'membership_permissions',
    underscored: true,
    paranoid: false,
    // The table has no updated_at column: flipping an override is modelled as
    // delete plus insert so the effect and its timestamp stay consistent.
    updatedAt: false,
  },
);
