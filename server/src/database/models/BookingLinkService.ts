/**
 * The services a CATALOG booking link offers, in the order they are shown.
 *
 * Only CATALOG links use this table; the other link types name their single
 * target directly on the BookingLink row.
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

export class BookingLinkService extends Model<
  InferAttributes<BookingLinkService>,
  InferCreationAttributes<BookingLinkService>
> {
  declare id: CreationOptional<string>;
  declare bookingLinkId: ForeignKey<string>;
  declare serviceId: ForeignKey<string>;
  /** Ascending display position on the public page; ties fall back to insertion order. */
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BookingLinkService.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bookingLinkId: { type: DataTypes.UUID, allowNull: false },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'BookingLinkService',
    tableName: 'booking_link_services',
    underscored: true,
    // Not paranoid: the join row has no deleted_at, and the unique index on
    // (booking_link_id, service_id) requires a removed pairing's row to be gone
    // before the same service can be added to the link again.
    paranoid: false,
  },
);
