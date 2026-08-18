/**
 * Platform user account.
 *
 * `platformRole` is intentionally coarse. Everything a person may do inside a
 * workspace is resolved from their Membership + Role + permission overrides —
 * see src/modules/auth/permissions.ts. A global flag must never be the reason
 * someone can read tenant data.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../../config/database';

export const PLATFORM_ROLES = ['ADMIN', 'USER'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare passwordHash: string;
  declare firstName: string;
  declare lastName: string;
  declare phone: string | null;
  declare avatarUrl: string | null;
  declare platformRole: CreationOptional<PlatformRole>;
  declare status: CreationOptional<UserStatus>;
  declare timezone: CreationOptional<string>;
  declare locale: CreationOptional<string>;
  declare emailVerifiedAt: Date | null;
  declare emailVerificationTokenHash: string | null;
  declare emailVerificationSentAt: Date | null;
  declare passwordResetTokenHash: string | null;
  declare passwordResetExpiresAt: Date | null;
  declare lastLoginAt: Date | null;
  declare failedLoginCount: CreationOptional<number>;
  declare lockedUntil: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  get fullName(): NonAttribute<string> {
    return `${this.firstName} ${this.lastName}`.trim();
  }

  /** True while a credential-stuffing lockout is still in force. */
  get isLocked(): NonAttribute<boolean> {
    return this.lockedUntil !== null && this.lockedUntil.getTime() > Date.now();
  }

  /**
   * The only shape of a user that may cross an API boundary.
   * Every secret column is omitted by construction rather than by deletion, so
   * adding a new secret column cannot accidentally leak through an old
   * serializer.
   */
  toPublicJSON(): NonAttribute<Record<string, unknown>> {
    return {
      id: this.id,
      email: this.email,
      firstName: this.firstName,
      lastName: this.lastName,
      fullName: this.fullName,
      phone: this.phone,
      avatarUrl: this.avatarUrl,
      platformRole: this.platformRole,
      status: this.status,
      timezone: this.timezone,
      locale: this.locale,
      emailVerified: this.emailVerifiedAt !== null,
      lastLoginAt: this.lastLoginAt,
      createdAt: this.createdAt,
    };
  }
}

User.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    email: { type: DataTypes.CITEXT, allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    firstName: { type: DataTypes.TEXT, allowNull: false },
    lastName: { type: DataTypes.TEXT, allowNull: false },
    phone: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.TEXT, allowNull: true },
    platformRole: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'USER' },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ACTIVE' },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },
    locale: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'en-US' },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    emailVerificationTokenHash: { type: DataTypes.TEXT, allowNull: true },
    emailVerificationSentAt: { type: DataTypes.DATE, allowNull: true },
    passwordResetTokenHash: { type: DataTypes.TEXT, allowNull: true },
    passwordResetExpiresAt: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    failedLoginCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    underscored: true,
    paranoid: true,
    // Secrets are excluded from every query unless a scope explicitly asks for
    // them, so a forgotten `attributes` list cannot ship a password hash.
    defaultScope: {
      attributes: {
        exclude: ['passwordHash', 'emailVerificationTokenHash', 'passwordResetTokenHash'],
      },
    },
    scopes: {
      // `User.scope('withSecrets')` replaces defaultScope entirely, so an empty
      // scope is what restores the excluded columns. Authentication flows are
      // the only callers.
      withSecrets: {},
    },
  },
);
