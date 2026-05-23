#!/usr/bin/env tsx
/**
 * Database Migration Runner
 *
 * Run with: npm run db:migrate
 */

import * as dotenv from 'dotenv';

dotenv.config();

import { initDatabase, runMigrations } from './index';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[migrate] ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

console.log('[migrate] Connecting to PostgreSQL...');

initDatabase(databaseUrl);

runMigrations()
  .then(() => {
    console.log('[migrate] Migrations complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  });
