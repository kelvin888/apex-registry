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

import * as dotenv from 'dotenv';

dotenv.config();

import { initDatabase, runMigrations } from './index';
import * as authService from '../services/auth';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('[seed] ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

async function seed() {
    console.log('[seed] Connecting to PostgreSQL...');
    initDatabase(databaseUrl!);
    await runMigrations();

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
        process.exit(0);
    } catch (err) {
        console.error('[seed] Failed:', err);
        process.exit(1);
    }
})();
