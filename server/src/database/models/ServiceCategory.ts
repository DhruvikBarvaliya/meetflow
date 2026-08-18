/**
 * Grouping of services on the booking page and in the admin catalogue.
 *
 * A category is presentational only: deleting one detaches its services
 * (`services.category_id` is ON DELETE SET NULL) rather than removing them, so
 * a merchandising change can never take bookable services offline.
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

export class ServiceCategory extends Model<
  InferAttributes<ServiceCategory>,
  InferCreationAttributes<ServiceCategory>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  declare color: string | null;
  declare sortOrder: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

ServiceCategory.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    color: { type: DataTypes.TEXT, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'ServiceCategory',
    tableName: 'service_categories',
    underscored: true,
    // Soft-deleted so the unique index on (business_id, slug) — which only
    // covers live rows — lets a retired slug be reused later.
    paranoid: true,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
