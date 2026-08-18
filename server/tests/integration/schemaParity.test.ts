/**
 * Model ↔ schema parity.
 *
 * Sequelize will happily run against a table whose real shape differs from the
 * model definition, and the mismatch only surfaces as a confusing runtime error
 * much later. This test compares every registered model against
 * `information_schema` and fails loudly on any drift:
 *
 *   - a column the model does not declare (silently unreadable/unwritable)
 *   - an attribute with no backing column (queries blow up at runtime)
 *   - a nullability disagreement (NOT NULL inserts that fail in production)
 *
 * It runs against the migrated test database, so it also proves the migrations
 * and the models are describing the same schema.
 */
import { QueryTypes, type Model, type ModelStatic } from 'sequelize';
import { afterAll, describe, expect, it } from 'vitest';
import { sequelize } from '../../src/config/database';
import { models } from '../../src/database/models';

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

const columnsByTable = new Map<string, Map<string, ColumnRow>>();

async function loadSchema(): Promise<void> {
  if (columnsByTable.size > 0) return;
  const rows = await sequelize.query<ColumnRow>(
    `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
    { type: QueryTypes.SELECT },
  );
  for (const row of rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Map());
    columnsByTable.get(row.table_name)!.set(row.column_name, row);
  }
}

afterAll(async () => {
  await sequelize.close();
});

describe('model ↔ database schema parity', () => {
  // The registry is a union of 42 concrete model classes; widening to
  // ModelStatic<Model> is what lets one generic assertion run over all of them.
  const entries = Object.entries(models) as Array<[string, ModelStatic<Model>]>;

  it('loads the migrated schema', async () => {
    await loadSchema();
    expect(columnsByTable.size).toBeGreaterThan(30);
  });

  it.each(entries)('%s declares exactly the columns its table has', async (name, model) => {
    await loadSchema();
    const tableName = model.getTableName() as string;
    const dbColumns = columnsByTable.get(tableName);

    expect(dbColumns, `table "${tableName}" for model ${name} does not exist`).toBeDefined();

    const attributes = model.getAttributes();
    const modelColumns = new Set(
      Object.values(attributes).map((attribute) => attribute.field ?? ''),
    );

    const missingInModel = [...dbColumns!.keys()].filter((column) => !modelColumns.has(column));
    const missingInDb = [...modelColumns].filter((column) => !dbColumns!.has(column));

    expect(
      missingInModel,
      `${name}: table ${tableName} has columns the model does not declare`,
    ).toEqual([]);
    expect(
      missingInDb,
      `${name}: model declares attributes with no matching column in ${tableName}`,
    ).toEqual([]);
  });

  it.each(entries)('%s agrees with the database on nullability', async (name, model) => {
    await loadSchema();
    const tableName = model.getTableName() as string;
    const dbColumns = columnsByTable.get(tableName)!;
    const mismatches: string[] = [];

    for (const attribute of Object.values(model.getAttributes())) {
      const column = attribute.field ? dbColumns.get(attribute.field) : undefined;
      if (!column) continue;

      const dbNullable = column.is_nullable === 'YES';
      // Sequelize treats `allowNull` as true unless explicitly set false.
      const modelNullable = attribute.allowNull !== false;

      // A model may be stricter than the database (declaring NOT NULL on a
      // nullable column is merely defensive), but the reverse is a real bug:
      // the insert will be rejected by PostgreSQL at runtime.
      //
      // Unless a value is guaranteed from somewhere: a model-side default, or a
      // database default such as `now()` on the timestamp columns Sequelize
      // manages itself. Either makes the omission safe.
      const hasFallback = attribute.defaultValue !== undefined || column.column_default !== null;
      if (modelNullable && !dbNullable && !hasFallback) {
        mismatches.push(
          `${attribute.field}: model allows null but the column is NOT NULL with no default`,
        );
      }
    }

    expect(mismatches, `${name} (${tableName})`).toEqual([]);
  });

  it('covers every table created by the migrations', async () => {
    await loadSchema();
    const modelled = new Set(Object.values(models).map((model) => model.getTableName() as string));
    // Sequelize's own bookkeeping tables are not domain entities.
    const infrastructure = new Set(['sequelize_meta', 'sequelize_seed_meta']);

    const unmodelled = [...columnsByTable.keys()].filter(
      (table) => !modelled.has(table) && !infrastructure.has(table),
    );

    expect(unmodelled, 'these tables exist but have no Sequelize model').toEqual([]);
  });
});
