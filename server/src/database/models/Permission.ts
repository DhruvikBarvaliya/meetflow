/**
 * Catalogue of every permission the platform recognises.
 *
 * Rows are seeded from code, not authored by tenants: `key` is the stable
 * machine identifier (e.g. 'appointments:cancel') that Role grants and
 * membership overrides reference, while `category` and `description` exist only
 * to render the permission picker.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../../config/database';

export class Permission extends Model<
  InferAttributes<Permission>,
  InferCreationAttributes<Permission>
> {
  declare id: CreationOptional<string>;
  declare key: string;
  declare category: string;
  declare description: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Permission.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    key: { type: DataTypes.TEXT, allowNull: false },
    category: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Permission',
    tableName: 'permissions',
    underscored: true,
    // Not paranoid: the catalogue is code-owned, so a removed permission is
    // removed outright rather than lingering as a soft-deleted row.
    paranoid: false,
  },
);
