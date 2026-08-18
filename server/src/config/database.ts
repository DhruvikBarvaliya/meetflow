/**
 * PostgreSQL connection.
 *
 * PostgreSQL is MeetFlow's single source of truth. Booking correctness depends
 * on transactional integrity here, never on Redis.
 */
import { QueryTypes, Sequelize } from 'sequelize';
import { databaseConfig, env, isProduction } from './env';
import { createLogger } from './logger';

const log = createLogger('database');

const commonOptions = {
  dialect: 'postgres' as const,
  // Every timestamp column is `timestamptz` and every instant is handled in
  // UTC. Pinning the driver to UTC removes any dependence on server locale.
  timezone: '+00:00',
  logging: databaseConfig.logging ? (sql: string) => log.debug({ sql }, 'sql') : false,
  pool: {
    min: databaseConfig.poolMin,
    max: databaseConfig.poolMax,
    acquire: 30_000,
    idle: 10_000,
  },
  retry: {
    // Transient connection resets only; never retry a failed transaction body.
    match: [/ECONNRESET/, /ETIMEDOUT/, /Connection terminated unexpectedly/],
    max: 3,
  },
  define: {
    underscored: true,
    freezeTableName: false,
    timestamps: true,
  },
  dialectOptions: databaseConfig.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
};

export const sequelize = databaseConfig.url
  ? new Sequelize(databaseConfig.url, commonOptions)
  : new Sequelize(databaseConfig.database, databaseConfig.username, databaseConfig.password, {
      ...commonOptions,
      host: databaseConfig.host,
      port: databaseConfig.port,
    });

/** Verifies the connection during boot; throws so the process fails loudly. */
export async function assertDatabaseConnection(): Promise<void> {
  await sequelize.authenticate();
  log.info(
    { database: databaseConfig.database, host: databaseConfig.url ? 'url' : databaseConfig.host },
    'PostgreSQL connection established',
  );

  if (isProduction) {
    // Schema changes are applied exclusively through migrations. Detect the
    // "someone forgot to migrate" case at boot instead of at first 500.
    const rows = await sequelize.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'sequelize_meta'",
      { type: QueryTypes.SELECT },
    );
    if (rows[0]?.count === '0' || rows.length === 0) {
      throw new Error(
        'Migration table `sequelize_meta` is missing. Run `npm run db:migrate` before starting the API.',
      );
    }
  }
}

export async function closeDatabase(): Promise<void> {
  await sequelize.close();
  log.info('PostgreSQL connection closed');
}

/** Exposed for diagnostics on /ready. */
export async function databaseHealth(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

export const dbLoggingEnabled = env.DB_LOGGING;
