/**
 * A single issued refresh token, stored as a digest only.
 *
 * Tokens are rotated on every use: the old row is revoked with reason ROTATED
 * and points at its successor through `replacedByTokenId`. Every token minted
 * from one login shares a `familyId`, so presenting an already-rotated token
 * proves theft and lets the whole family be revoked at once.
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

export const REFRESH_TOKEN_REVOKED_REASONS = [
  'ROTATED',
  'LOGOUT',
  'LOGOUT_ALL',
  'REUSE_DETECTED',
  'PASSWORD_CHANGED',
  'ADMIN_REVOKED',
  'EXPIRED',
] as const;
export type RefreshTokenRevokedReason = (typeof REFRESH_TOKEN_REVOKED_REASONS)[number];

export class RefreshToken extends Model<
  InferAttributes<RefreshToken>,
  InferCreationAttributes<RefreshToken>
> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<string>;
  declare tokenHash: string;
  /**
   * Not a foreign key: the family is identified by the id of its first token,
   * which may be purged long before its descendants expire.
   */
  declare familyId: string;
  declare issuedAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare revokedReason: RefreshTokenRevokedReason | null;
  declare replacedByTokenId: ForeignKey<string> | null;
  declare userAgent: string | null;
  declare ipAddress: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  get isExpired(): NonAttribute<boolean> {
    return this.expiresAt.getTime() <= Date.now();
  }

  get isRevoked(): NonAttribute<boolean> {
    return this.revokedAt !== null;
  }

  /**
   * The single check the refresh endpoint must make. A token that fails this
   * while still being presented is the signal that triggers family revocation.
   */
  get isUsable(): NonAttribute<boolean> {
    return !this.isRevoked && !this.isExpired;
  }
}

RefreshToken.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.TEXT, allowNull: false },
    familyId: { type: DataTypes.UUID, allowNull: false },
    issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokedReason: { type: DataTypes.TEXT, allowNull: true },
    replacedByTokenId: { type: DataTypes.UUID, allowNull: true },
    userAgent: { type: DataTypes.TEXT, allowNull: true },
    ipAddress: { type: DataTypes.INET, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'RefreshToken',
    tableName: 'refresh_tokens',
    underscored: true,
    // Not paranoid: revocation is modelled explicitly by revokedAt/revokedReason,
    // and expired rows are hard-deleted by the purge job.
    paranoid: false,
  },
);
