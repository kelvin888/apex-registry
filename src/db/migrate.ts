#!/usr/bin/env tsx
/**
 * Database Migration Runner
 *
 * Run with: npm run db:migrate
 */

import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config();

import { initDatabase, runMigrations } from './index';

const rawPath = process.env.DATABASE_PATH || './data/apex.db';
const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

console.log(`[migrate] Database: ${dbPath}`);

initDatabase({ path: dbPath });
runMigrations();

console.log('[migrate] Migrations complete.');
