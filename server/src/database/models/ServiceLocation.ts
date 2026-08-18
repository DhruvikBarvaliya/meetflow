/**
 * Restricts a service to specific locations.
 *
 * Absence of rows is meaningful: a service with no service_locations rows is
 * offered at every active location, so callers must treat an empty set as
 * "everywhere" rather than as "nowhere".
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

export class ServiceLocation extends Model<
  InferAttributes<ServiceLocation>,
  InferCreationAttributes<ServiceLocation>
> {
  declare id: CreationOptional<string>;
  declare serviceId: ForeignKey<string>;
  declare locationId: ForeignKey<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ServiceLocation.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'ServiceLocation',
    tableName: 'service_locations',
    underscored: true,
    // Not paranoid: the join row has no deleted_at, and the unique index on
    // (service_id, location_id) requires a withdrawn pairing's row to be gone
    // so the service can be offered at that location again.
    paranoid: false,
  },
);
