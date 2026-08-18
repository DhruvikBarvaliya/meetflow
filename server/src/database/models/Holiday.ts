/**
 * A calendar day the business observes as a holiday.
 *
 * `closesBusiness` separates the two real cases: a day that removes all
 * availability, and a day that is merely labelled for customers while the
 * business stays open on reduced or unchanged hours.
 *
 * When `isRecurringAnnually` is set, `date` records the first observed year and
 * only its month/day are matched thereafter — which is what the partial
 * month/day index on this table serves.
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

export class Holiday extends Model<InferAttributes<Holiday>, InferCreationAttributes<Holiday>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  /** NULL means every location observes the holiday. */
  declare locationId: ForeignKey<string> | null;
  declare name: string;
  // DATEONLY is read and written as a 'YYYY-MM-DD' string.
  declare date: string;
  declare isRecurringAnnually: CreationOptional<boolean>;
  declare closesBusiness: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * The 'MM-DD' projection a recurring holiday is matched on, so callers do not
   * re-derive it (and re-derive it inconsistently) from the stored date.
   */
  get monthDay(): NonAttribute<string> {
    return this.date.slice(5);
  }

  /** True only when this row actually suppresses availability on its day. */
  get isClosure(): NonAttribute<boolean> {
    return this.isActive && this.closesBusiness;
  }
}

Holiday.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    isRecurringAnnually: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    closesBusiness: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Holiday',
    tableName: 'holidays',
    underscored: true,
    // No deleted_at column: a holiday no longer observed is deactivated, which
    // keeps the unique (business, location, date, name) index honest.
    paranoid: false,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
