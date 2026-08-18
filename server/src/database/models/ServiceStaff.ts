/**
 * Which staff member may deliver which service, plus the per-pairing overrides.
 *
 * `durationMinutesOverride` and `priceAmountOverride` are NULL when the pairing
 * simply uses the service's own values — a senior provider can take longer or
 * charge more for the same service without forking the catalogue entry.
 * `weight` skews round-robin share and `priority` breaks ties, exactly as on
 * TeamMember, so the assignment engine reads both tables the same way.
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

export class ServiceStaff extends Model<
  InferAttributes<ServiceStaff>,
  InferCreationAttributes<ServiceStaff>
> {
  declare id: CreationOptional<string>;
  declare serviceId: ForeignKey<string>;
  declare staffProfileId: ForeignKey<string>;
  declare durationMinutesOverride: number | null;
  declare priceAmountOverride: number | null;
  declare priority: CreationOptional<number>;
  declare weight: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ServiceStaff.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: false },
    durationMinutesOverride: { type: DataTypes.INTEGER, allowNull: true },
    priceAmountOverride: { type: DataTypes.INTEGER, allowNull: true },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    weight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'ServiceStaff',
    tableName: 'service_staff',
    underscored: true,
    // Not paranoid: the join row has no deleted_at, and the unique index on
    // (service_id, staff_profile_id) requires an unassigned pairing's row to be
    // gone so it can be assigned again. `isActive` covers pausing instead.
    paranoid: false,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
