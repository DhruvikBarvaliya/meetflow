#!/usr/bin/env node
/**
 * Rebuild the development database from nothing: drop, migrate, seed.
 *
 * Exists because the obvious three-command chain has a trap. `db:migrate:undo:all`
 * drops every domain table but leaves `sequelize_seed_meta` behind, so the CLI
 * still believes the seeders have run and answers the following `db:seed:all`
 * with "No seeders found" — leaving an empty, migrated database and no error to
 * explain it. Clearing that bookkeeping between the two steps is the fix.
 *
 *   npm --workspace server run db:reset
 */
import { execFileSync } from 'node:child_process';

const run = (args) =>
  execFileSync('npx', ['sequelize-cli', ...args], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

console.log('\n▸ dropping every table');
run(['db:migrate:undo:all']);

console.log('\n▸ applying migrations');
run(['db:migrate']);

console.log('\n▸ clearing stale seed bookkeeping');
// `sequelize_seed_meta` outlives the tables it describes, so a reset has to
// forget what it thinks it has already seeded.
run(['db:seed:undo:all']);

console.log('\n▸ seeding development data');
run(['db:seed:all']);

console.log('\n✔ database reset complete\n');
