/**
 * What a service needs from the resource pool, expressed either as one specific
 * resource or as "any `quantity` resources of this type".
 *
 * A database CHECK guarantees exactly one of `resourceId` / `resourceType` is
 * set per row, so `isPooled` is a total description of the row's form.
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
import type { ResourceType } from './Resource';

// `resource_type` carries the same CHECK list as resources.type; re-exporting
// the single tuple from Resource keeps the two lists from drifting apart.
export { RESOURCE_TYPES } from './Resource';
export type { ResourceType };

export class ServiceResourceRequirement extends Model<
  InferAttributes<ServiceResourceRequirement>,
  InferCreationAttributes<ServiceResourceRequirement>
> {
  declare id: CreationOptional<string>;
  declare serviceId: ForeignKey<string>;
  declare resourceId: ForeignKey<string> | null;
  declare resourceType: ResourceType | null;
  declare quantity: CreationOptional<number>;
  declare isRequired: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * A pooled requirement is satisfied by any `quantity` free resources of
   * `resourceType`; a non-pooled one names the exact resource to reserve.
   */
  get isPooled(): NonAttribute<boolean> {
    return this.resourceId === null;
  }
}

ServiceResourceRequirement.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    resourceId: { type: DataTypes.UUID, allowNull: true },
    resourceType: { type: DataTypes.TEXT, allowNull: true },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    isRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'ServiceResourceRequirement',
    tableName: 'service_resource_requirements',
    underscored: true,
    // Not paranoid: the table has no deleted_at. A dropped requirement is
    // deleted outright; appointments keep their own reservation rows.
    paranoid: false,
  },
);
