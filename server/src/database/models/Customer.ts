/**
 * Customer — a bookable person, scoped to exactly one business.
 *
 * A customer deliberately exists independently of a login: most public bookings
 * arrive with nothing but a name and an email, and `userId` is filled in only if
 * that person later creates a MeetFlow account. The same human booking with two
 * businesses is two rows, because tenants never share customer data.
 *
 * The counter columns (`totalBookings`, `completedCount`, `cancelledCount`,
 * `noShowCount`) and the first/last appointment stamps are denormalised
 * reporting accelerators maintained by the lifecycle service. Appointments
 * remain the source of truth — never reconcile the other way round.
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

export const CUSTOMER_STATUSES = ['ACTIVE', 'BLOCKED', 'ARCHIVED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export class Customer extends Model<InferAttributes<Customer>, InferCreationAttributes<Customer>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  /** Opaque handle used in customer-facing links; the uuid is never exposed. */
  declare publicId: string;
  declare userId: ForeignKey<string> | null;
  declare firstName: string;
  declare lastName: string | null;
  declare email: string;
  declare phone: string | null;
  declare timezone: CreationOptional<string>;
  declare locale: CreationOptional<string>;
  declare notes: string | null;
  declare tags: CreationOptional<string[]>;
  declare preferredStaffProfileId: ForeignKey<string> | null;
  declare preferredLocationId: ForeignKey<string> | null;
  /** { emailEnabled, smsEnabled, reminderOffsetsMinutes, marketingOptIn } */
  declare communicationPreferences: CreationOptional<Record<string, unknown>>;
  declare status: CreationOptional<CustomerStatus>;

  declare totalBookings: CreationOptional<number>;
  declare completedCount: CreationOptional<number>;
  declare cancelledCount: CreationOptional<number>;
  declare noShowCount: CreationOptional<number>;
  declare firstAppointmentAt: Date | null;
  declare lastAppointmentAt: Date | null;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /** `lastName` is optional, so naive concatenation would leave a trailing space. */
  get fullName(): NonAttribute<string> {
    return [this.firstName, this.lastName].filter(Boolean).join(' ');
  }

  /**
   * Only an ACTIVE customer may take a new appointment. BLOCKED is a deliberate
   * ban and ARCHIVED is a retired record; both keep their history bookable to
   * read but not to extend.
   */
  get isBookable(): NonAttribute<boolean> {
    return this.status === 'ACTIVE';
  }

  /**
   * Share of finished bookings the customer failed to attend, used by deposit
   * and approval policies. Returns 0 rather than NaN for a customer with no
   * completed history yet.
   */
  get noShowRate(): NonAttribute<number> {
    const settled = this.completedCount + this.noShowCount;
    return settled === 0 ? 0 : this.noShowCount / settled;
  }
}

Customer.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    publicId: { type: DataTypes.TEXT, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: true },
    firstName: { type: DataTypes.TEXT, allowNull: false },
    lastName: { type: DataTypes.TEXT, allowNull: true },
    email: { type: DataTypes.CITEXT, allowNull: false },
    phone: { type: DataTypes.TEXT, allowNull: true },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },
    locale: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'en-US' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    tags: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    preferredStaffProfileId: { type: DataTypes.UUID, allowNull: true },
    preferredLocationId: { type: DataTypes.UUID, allowNull: true },
    communicationPreferences: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: { emailEnabled: true, smsEnabled: false, marketingOptIn: false },
    },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ACTIVE' },

    totalBookings: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    completedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cancelledCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    noShowCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    firstAppointmentAt: { type: DataTypes.DATE, allowNull: true },
    lastAppointmentAt: { type: DataTypes.DATE, allowNull: true },

    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Customer',
    tableName: 'customers',
    underscored: true,
    // Paranoid: the unique index on (business_id, email) is filtered to
    // `deleted_at IS NULL`, so a soft delete both preserves the booking history
    // an appointment still points at and frees the address for re-registration.
    paranoid: true,
  },
);
