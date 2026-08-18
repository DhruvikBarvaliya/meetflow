/**
 * The bookable identity of a person inside one business.
 *
 * Kept separate from User because the same account can hold a profile in
 * several businesses, and because every scheduling attribute here (colour,
 * buffers, load limits, bookability) is workspace-scoped rather than global.
 *
 * The buffer/notice/load columns are NULL when the profile inherits the
 * business defaults — NULL means "inherit", 0 means "explicitly none".
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

export class StaffProfile extends Model<
  InferAttributes<StaffProfile>,
  InferCreationAttributes<StaffProfile>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare userId: ForeignKey<string>;
  declare membershipId: ForeignKey<string>;
  declare displayName: string;
  declare title: string | null;
  declare bio: string | null;
  declare avatarUrl: string | null;
  declare timezone: CreationOptional<string>;
  declare color: CreationOptional<string>;
  declare defaultLocationId: ForeignKey<string> | null;
  declare isBookable: CreationOptional<boolean>;
  declare preBufferMinutes: number | null;
  declare postBufferMinutes: number | null;
  declare minNoticeMinutes: number | null;
  declare maxDailyAppointments: number | null;
  declare maxWeeklyAppointments: number | null;
  declare lastAssignedAt: Date | null;
  declare assignmentWeight: CreationOptional<number>;
  declare sortOrder: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * Both flags must hold before this profile may be offered publicly: a staff
   * member can be deactivated entirely, or stay active while temporarily
   * withdrawn from booking. Availability queries check this, never one flag.
   */
  get isAssignable(): NonAttribute<boolean> {
    return this.isActive && this.isBookable;
  }
}

StaffProfile.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    membershipId: { type: DataTypes.UUID, allowNull: false },
    displayName: { type: DataTypes.TEXT, allowNull: false },
    title: { type: DataTypes.TEXT, allowNull: true },
    bio: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.TEXT, allowNull: true },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },
    color: { type: DataTypes.TEXT, allowNull: false, defaultValue: '#4F46E5' },
    defaultLocationId: { type: DataTypes.UUID, allowNull: true },
    isBookable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    preBufferMinutes: { type: DataTypes.INTEGER, allowNull: true },
    postBufferMinutes: { type: DataTypes.INTEGER, allowNull: true },
    minNoticeMinutes: { type: DataTypes.INTEGER, allowNull: true },
    maxDailyAppointments: { type: DataTypes.INTEGER, allowNull: true },
    maxWeeklyAppointments: { type: DataTypes.INTEGER, allowNull: true },
    lastAssignedAt: { type: DataTypes.DATE, allowNull: true },
    assignmentWeight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'StaffProfile',
    tableName: 'staff_profiles',
    underscored: true,
    // Soft-deleted so appointments a departed staff member handled keep their
    // provider, and so the partial unique index on (business_id, user_id)
    // lets the same person be re-onboarded later.
    paranoid: true,
    scopes: {
      // Matches the staff_profiles_business_bookable_idx access path used by
      // every public availability lookup.
      bookable: { where: { isActive: true, isBookable: true } },
    },
  },
);
