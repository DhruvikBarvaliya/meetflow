/* eslint-disable */
/**
 * sequelize-cli configuration.
 *
 * The CLI runs outside the TypeScript application, so this file deliberately
 * stays plain CommonJS and reads configuration straight from the environment.
 * It must produce the *same* connection settings as src/config/database.ts —
 * migrations and the runtime always target one schema.
 */
const path = require('node:path');
const fs = require('node:fs');

// Load .env from the server workspace, then the repository root, so a single
// root-level .env works for both `npm run db:migrate` and `npm run dev`.
const candidates = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];
for (const file of candidates) {
  if (fs.existsSync(file)) {
    require('dotenv').config({ path: file });
    break;
  }
}

const asBool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const ssl = asBool(process.env.DB_SSL, false);

/**
 * Shared shape for every environment the CLI understands.
 *
 * `urlVar` names the environment variable that may supply a full connection
 * string. It is explicit rather than always falling back to DATABASE_URL,
 * because a shared fallback would silently point `--env test` at the
 * development database and migrate the wrong schema.
 */
function build(urlVar, overrides = {}) {
  const base = {
    username: process.env.DB_USER || 'meetflow',
    password: process.env.DB_PASSWORD || 'meetflow',
    database: process.env.DB_NAME || 'meetflow_dev',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: asBool(process.env.DB_LOGGING, false) ? console.log : false,
    // Timestamps are stored as `timestamptz`; keep the driver in UTC so no
    // implicit local-time conversion can corrupt an instant.
    timezone: '+00:00',
    dialectOptions: ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    define: { underscored: true, freezeTableName: false },
    migrationStorageTableName: 'sequelize_meta',
    seederStorage: 'sequelize',
    seederStorageTableName: 'sequelize_seed_meta',
    ...overrides,
  };

  // A connection string, when the named variable is set, wins over the
  // discrete DB_* values.
  const url = urlVar ? process.env[urlVar] : undefined;
  if (url) base.url = url;
  return base;
}

module.exports = {
  development: build('DATABASE_URL'),
  // The integration suite points at a dedicated database (see docker/postgres).
  // It deliberately ignores DATABASE_URL — only TEST_DATABASE_URL may redirect
  // it — so `--env test` can never migrate or truncate development data.
  test: build('TEST_DATABASE_URL', {
    database: process.env.TEST_DB_NAME || 'meetflow_test',
    logging: false,
  }),
  production: build('DATABASE_URL'),
};
