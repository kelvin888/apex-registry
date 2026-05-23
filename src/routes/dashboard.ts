/**
 * Dashboard Routes
 *
 * Aggregated stats and chart data for the developer portal.
 * All endpoints require authentication.
 */

import { FastifyPluginAsync } from 'fastify';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { getDatabase, apps, versions, downloads, developers } from '../db';

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * GET /api/dashboard/stats
     *
     * Returns top-line numbers for the portal overview page.
     * Scoped to the authenticated developer's own apps.
     */
    fastify.get('/stats', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Aggregated stats for the current developer',
            tags: ['dashboard'],
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        totalApps: { type: 'number' },
                        totalDownloads: { type: 'number' },
                        activeUsers: { type: 'number' },
                        revenue: { type: 'number' },
                        changes: {
                            type: 'object',
                            properties: {
                                apps: { type: 'number' },
                                downloads: { type: 'number' },
                                users: { type: 'number' },
                                revenue: { type: 'number' },
                            },
                        },
                    },
                },
            },
        },
    }, async (request: any) => {
        const db = getDatabase();
        const developerId = request.user.id;

        // Apps owned by this developer
        const myApps = await db.select({ id: apps.id })
            .from(apps)
            .where(eq(apps.developerId, developerId));

        const totalApps = myApps.length;

        // Downloads across all versions of this developer's apps
        let totalDownloads = 0;
        if (totalApps > 0) {
            const appIds = myApps.map((a: { id: string }) => a.id);

            const [dlResult] = await db.select({ count: sql<number>`count(*)` })
                .from(downloads)
                .innerJoin(versions, eq(downloads.versionId, versions.id))
                .where(inArray(versions.appId, appIds))
                .limit(1);

            totalDownloads = dlResult?.count ?? 0;
        }

        // Total registered developers — admin-only platform metric
        const totalDevelopers = request.user.role === 'admin'
            ? (await db.select({ count: sql<number>`count(*)` }).from(developers).limit(1))[0]
            : null;

        // 30-day window change estimates (downloads this month vs previous month)
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

        let downloadsThisMonth = 0;
        let downloadsPrevMonth = 0;

        if (totalApps > 0) {
            const appIds = myApps.map((a: { id: string }) => a.id);

            const [thisMonthResult] = await db.select({ count: sql<number>`count(*)` })
                .from(downloads)
                .innerJoin(versions, eq(downloads.versionId, versions.id))
                .where(and(
                    inArray(versions.appId, appIds),
                    sql`${downloads.createdAt} >= ${thirtyDaysAgo}`,
                ))
                .limit(1);

            const [prevMonthResult] = await db.select({ count: sql<number>`count(*)` })
                .from(downloads)
                .innerJoin(versions, eq(downloads.versionId, versions.id))
                .where(and(
                    inArray(versions.appId, appIds),
                    sql`${downloads.createdAt} >= ${sixtyDaysAgo}`,
                    sql`${downloads.createdAt} < ${thirtyDaysAgo}`,
                ))
                .limit(1);

            downloadsThisMonth = thisMonthResult?.count ?? 0;
            downloadsPrevMonth = prevMonthResult?.count ?? 0;
        }

        const downloadChangePercent = downloadsPrevMonth > 0
            ? Math.round(((downloadsThisMonth - downloadsPrevMonth) / downloadsPrevMonth) * 100)
            : 0;

        return {
            totalApps,
            totalDownloads,
            activeUsers: totalDevelopers?.count ?? 0,
            revenue: 0, // Revenue tracking not yet implemented
            changes: {
                apps: 0,
                downloads: downloadChangePercent,
                users: 0,
                revenue: 0,
            },
        };
    });

    /**
     * GET /api/dashboard/chart
     *
     * Returns daily download counts over the last 30 days for the portal chart.
     * Scoped to the authenticated developer's apps.
     */
    fastify.get('/chart', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Daily download chart data for the last 30 days',
            tags: ['dashboard'],
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            date: { type: 'string' },
                            downloads: { type: 'number' },
                            users: { type: 'number' },
                        },
                    },
                },
            },
        },
    }, async (request: any) => {
        const db = getDatabase();
        const developerId = request.user.id;

        const myApps = await db.select({ id: apps.id })
            .from(apps)
            .where(eq(apps.developerId, developerId));

        if (myApps.length === 0) {
            return [];
        }

        const appIds = myApps.map((a: { id: string }) => a.id);
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

        const rows = await db.select({
            date: sql<string>`date(${downloads.createdAt} / 1000, 'unixepoch')`,
            count: sql<number>`count(*)`,
        })
            .from(downloads)
            .innerJoin(versions, eq(downloads.versionId, versions.id))
            .where(and(
                inArray(versions.appId, appIds),
                sql`${downloads.createdAt} >= ${cutoff}`,
            ))
            .groupBy(sql`date(${downloads.createdAt} / 1000, 'unixepoch')`);

        // Build a map for quick lookup, then fill all 30 days so the chart has no gaps
        const byDate = new Map<string, number>(rows.map((r: { date: string; count: number }) => [r.date, r.count]));
        const result: Array<{ date: string; downloads: number; users: number }> = [];

        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
            result.push({
                date: dateStr,
                downloads: byDate.get(dateStr) ?? 0,
                users: 0, // Individual user tracking not yet implemented
            });
        }

        return result;
    });
};
