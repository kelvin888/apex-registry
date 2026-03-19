#!/usr/bin/env tsx
/**
 * Promote Admin Script
 *
 * Promotes an existing developer account to the 'admin' role.
 * Run with: npm run db:promote-admin
 *
 * Required environment variable:
 *   PROMOTE_EMAIL=someone@example.com
 */

import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config();

import { eq } from 'drizzle-orm';
import { initDatabase, runMigrations, developers } from './index';

const email = process.env.PROMOTE_EMAIL;
if (!email) {
    console.error('[promote-admin] Error: PROMOTE_EMAIL environment variable is required.');
    console.error('[promote-admin] Usage: PROMOTE_EMAIL=you@example.com npm run db:promote-admin');
    process.exit(1);
}

const rawPath = process.env.DATABASE_PATH || './data/apex.db';
const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

async function promoteAdmin(emailStr: string) {
    console.log(`[promote-admin] Database: ${dbPath}`);
    const db = initDatabase({ path: dbPath });
    runMigrations();

    const existing = db.select({ id: developers.id, email: developers.email, role: developers.role })
        .from(developers)
        .where(eq(developers.email, emailStr))
        .get();

    if (!existing) {
        console.error(`[promote-admin] No account found for email: ${emailStr}`);
        process.exit(1);
    }

    if (existing.role === 'admin') {
        console.log(`[promote-admin] ${emailStr} is already an admin. Nothing to do.`);
        return;
    }

    db.update(developers)
        .set({ role: 'admin', updatedAt: new Date() })
        .where(eq(developers.email, emailStr))
        .run();

    console.log(`[promote-admin] ✓ ${emailStr} has been promoted to admin.`);
}

(async () => { // NOSONAR - top-level await unavailable in CJS; IIFE is the correct pattern
    try {
        await promoteAdmin(email);
    } catch (err) {
        console.error('[promote-admin] Failed:', err);
        process.exit(1);
    }
})();
