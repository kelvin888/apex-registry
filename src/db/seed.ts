#!/usr/bin/env tsx
/**
 * Database Seed Script
 *
 * Populates the database with initial test data.
 * Run with: npm run db:seed
 *
 * Default credentials:
 *   Email:    test@interswitch.com
 *   Password: Password123!
 */

import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config();

import { initDatabase, runMigrations } from './index';
import * as authService from '../services/auth';

const rawPath = process.env.DATABASE_PATH || './data/apex.db';
const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

async function seed() {
    console.log(`[seed] Database: ${dbPath}`);
    initDatabase({ path: dbPath });
    runMigrations();

    // ── Developer ─────────────────────────────────────────────────────────────
    try {
        await authService.registerDeveloper({
            email: 'test@interswitch.com',
            password: 'Password123!', // NOSONAR - seed data only, never used in production
            name: 'Test Developer',
            organization: 'Interswitch',
        });
        console.log('[seed] Created developer: test@interswitch.com');
    } catch (err: any) {
        if (err.message === 'Email already registered') {
            console.log('[seed] Developer test@interswitch.com already exists, skipping.');
        } else {
            throw err;
        }
    }

    console.log('[seed] Done.');
}

(async () => { // NOSONAR - top-level await unavailable in CJS; IIFE is the correct pattern
    try {
        await seed();
    } catch (err) {
        console.error('[seed] Failed:', err);
        process.exit(1);
    }
})();
