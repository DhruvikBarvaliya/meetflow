/**
 * A customer's standing request for a slot that does not exist yet.
 *
 * The desired window is stored as a calendar date range plus a minute-of-day
 * range rather than as two timestamps, because the request is recurring in
 * nature ("any weekday afternoon in the next fortnight") and must be evaluated
 * against openings that are only discovered later. `timezone` is what gives
 * those local dates and minutes an absolute meaning.
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

export const WAITLIST_STATUSES = [
  'ACTIVE',
  'NOTIFIED',
  'CONVERTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const WAITLIST_NOTIFY_CHANNELS = ['EMAIL', 'SMS', 'NONE'] as const;
export type WaitlistNotifyChannel = (typeof WAITLIST_NOTIFY_CHANNELS)[number];

export class WaitlistEntry extends Model<
  InferAttributes<WaitlistEntry>,
  InferCreationAttributes<WaitlistEntry>
> {
  declare id: CreationOptional<string>;
  declare publicId: string;
  declare businessId: ForeignKey<string>;
  declare customerId: ForeignKey<string>;
  declare serviceId: ForeignKey<string>;
  declare staffProfileId: ForeignKey<string> | null;
  declare locationId: ForeignKey<string> | null;

  // DATEONLY columns round-trip as 'YYYY-MM-DD' strings; keeping them as
  // strings avoids a Date object silently dragging a UTC offset into a value
  // that is deliberately timezone-free.
  declare earliestDate: string;
  declare latestDate: string;
  declare earliestMinute: CreationOptional<number>;
  declare latestMinute: CreationOptional<number>;
  declare daysOfWeek: CreationOptional<number[]>;
  declare timezone: CreationOptional<string>;

  declare status: CreationOptional<WaitlistStatus>;
  declare priority: CreationOptional<number>;
  declare notifyChannel: CreationOptional<WaitlistNotifyChannel>;
  declare notifiedAt: Date | null;
  declare notificationCount: CreationOptional<number>;

  declare holdExpiresAt: Date | null;
  declare heldSlotStartsAt: Date | null;
  declare convertedAppointmentId: ForeignKey<string> | null;
  declare expiresAt: Date | null;
  declare note: string | null;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * True while this entry still owns the opening it was notified about. The
   * matcher must skip that slot for everyone else until the hold lapses.
   */
  get hasActiveHold(): NonAttribute<boolean> {
    return this.holdExpiresAt !== null && this.holdExpiresAt.getTime() > Date.now();
  }

  /** Empty `daysOfWeek` means "no weekday restriction", not "no day works". */
  get acceptsAnyWeekday(): NonAttribute<boolean> {
    return this.daysOfWeek.length === 0;
  }
}

WaitlistEntry.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    publicId: { type: DataTypes.TEXT, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    customerId: { type: DataTypes.UUID, allowNull: false },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: true },
    locationId: { type: DataTypes.UUID, allowNull: true },

    earliestDate: { type: DataTypes.DATEONLY, allowNull: false },
    latestDate: { type: DataTypes.DATEONLY, allowNull: false },
    earliestMinute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    latestMinute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1439 },
    daysOfWeek: {
      type: DataTypes.ARRAY(DataTypes.SMALLINT),
      allowNull: false,
      defaultValue: [],
    },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },

    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ACTIVE' },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    notifyChannel: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'EMAIL' },
    notifiedAt: { type: DataTypes.DATE, allowNull: true },
    notificationCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    holdExpiresAt: { type: DataTypes.DATE, allowNull: true },
    heldSlotStartsAt: { type: DataTypes.DATE, allowNull: true },
    convertedAppointmentId: { type: DataTypes.UUID, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },

    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'WaitlistEntry',
    tableName: 'waitlist_entries',
    underscored: true,
    // Not paranoid: CANCELLED and EXPIRED are the terminal states, and the row
    // must stay visible so a customer can see why they were never called.
    paranoid: false,
    scopes: {
      /**
       * The only entries the matcher may consider. Ordered exactly like
       * `waitlist_eligibility_idx`: priority first, then FIFO by arrival, so
       * two customers with equal priority are served in the order they asked.
       */
      matchable: {
        where: { status: ['ACTIVE', 'NOTIFIED'] },
        order: [
          ['priority', 'ASC'],
          ['createdAt', 'ASC'],
        ],
      },
    },
  },
);
