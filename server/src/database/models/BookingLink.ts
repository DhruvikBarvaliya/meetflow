/**
 * Public booking link — the entry point a customer actually lands on.
 *
 * `type` decides which target column must be populated, and the database
 * enforces the pairing with the `booking_links_target_check` constraint:
 * SINGLE_SERVICE needs `serviceId`, TEAM needs `teamId`, STAFF needs
 * `staffProfileId`, and CATALOG needs none of them because its offering comes
 * from the BookingLinkService rows instead.
 *
 * `slug` is unique across the whole platform, not per tenant, because it is the
 * entire public URL path.
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

export const BOOKING_LINK_TYPES = ['SINGLE_SERVICE', 'CATALOG', 'TEAM', 'STAFF'] as const;
export type BookingLinkType = (typeof BOOKING_LINK_TYPES)[number];

export class BookingLink extends Model<
  InferAttributes<BookingLink>,
  InferCreationAttributes<BookingLink>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare slug: string;
  declare name: string;
  declare description: string | null;
  declare type: CreationOptional<BookingLinkType>;
  declare serviceId: ForeignKey<string> | null;
  declare teamId: ForeignKey<string> | null;
  declare staffProfileId: ForeignKey<string> | null;
  declare locationId: ForeignKey<string> | null;
  /** When false the assignment engine picks the provider, not the customer. */
  declare allowStaffSelection: CreationOptional<boolean>;
  declare requiresApproval: CreationOptional<boolean>;
  /** Extra booking-form questions: [{ key, label, type, required, options[] }] */
  declare customQuestions: CreationOptional<Record<string, unknown>[]>;
  declare branding: CreationOptional<Record<string, unknown>>;
  /** Null means uncapped — a zero cap is rejected by the column's CHECK. */
  declare maxBookingsTotal: number | null;
  declare bookingCount: CreationOptional<number>;
  declare expiresAt: Date | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /** True once the campaign window has closed. */
  get isExpired(): NonAttribute<boolean> {
    return this.expiresAt !== null && this.expiresAt.getTime() <= Date.now();
  }

  /** True when a capped link has already taken every booking it was allowed. */
  get isExhausted(): NonAttribute<boolean> {
    return this.maxBookingsTotal !== null && this.bookingCount >= this.maxBookingsTotal;
  }

  /**
   * The single question the public booking page asks. Kept as one getter so a
   * caller cannot check the active flag and forget the expiry or the cap.
   */
  get isBookable(): NonAttribute<boolean> {
    return this.isActive && !this.isExpired && !this.isExhausted;
  }
}

BookingLink.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'CATALOG' },
    serviceId: { type: DataTypes.UUID, allowNull: true },
    teamId: { type: DataTypes.UUID, allowNull: true },
    staffProfileId: { type: DataTypes.UUID, allowNull: true },
    locationId: { type: DataTypes.UUID, allowNull: true },
    allowStaffSelection: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requiresApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    customQuestions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    branding: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    maxBookingsTotal: { type: DataTypes.INTEGER, allowNull: true },
    bookingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'BookingLink',
    tableName: 'booking_links',
    underscored: true,
    // Paranoid: the unique slug index is filtered to `deleted_at IS NULL`, so a
    // retired link keeps the appointments that reference it while releasing its
    // public path for reuse.
    paranoid: true,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
