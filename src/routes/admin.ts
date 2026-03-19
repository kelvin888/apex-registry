/**
 * Admin Routes
 *
 * Platform management endpoints. All routes require admin role.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, apps, developers, versions, downloads, reviews } from '../db';

const requireAdmin = async (request: any, reply: any) => {
    if (request.user.role !== 'admin') {
        reply.code(403).send({ error: 'Forbidden: admin access required' });
    }
};

const reviewSchema = z.object({
    action: z.enum(['approve', 'reject']),
    notes: z.string().optional(),
});

async function upsertReviewRecord(
    db: ReturnType<typeof getDatabase>,
    versionId: string,
    reviewerId: string,
    action: 'approve' | 'reject',
    notes: string | undefined,
    now: Date,
) {
    const reviewStatus = action === 'approve' ? 'approved' : 'rejected';
    const rejectionReason = action === 'reject' ? (notes ?? null) : null;

    const existing = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.versionId, versionId))
        .get();

    if (existing) {
        await db.update(reviews).set({
            reviewerId,
            status: reviewStatus,
            notes: notes ?? null,
            rejectionReason,
            reviewedAt: now,
        }).where(eq(reviews.id, existing.id));
    } else {
        await db.insert(reviews).values({
            id: nanoid(),
            versionId,
            reviewerId,
            status: reviewStatus,
            notes: notes ?? null,
            rejectionReason,
            submittedAt: now,
            reviewedAt: now,
        });
    }
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * GET /api/admin/apps
     * All apps on the platform with developer info, optional status filter and search.
     */
    fastify.get('/apps', {
        onRequest: [fastify.authenticate, requireAdmin],
        schema: {
            description: 'List all apps on the platform (admin only)',
            tags: ['admin'],
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    search: { type: 'string' },
                    limit: { type: 'number' },
                    offset: { type: 'number' },
                },
            },
        },
    }, async (request: any) => {
        const db = getDatabase();
        const { status, search, limit = 50, offset = 0 } = request.query as {
            status?: string;
            search?: string;
            limit?: number;
            offset?: number;
        };

        const conditions = [];
        if (status && status !== 'all') {
            conditions.push(eq(apps.status, status as any));
        }
        if (search) {
            conditions.push(like(apps.name, `%${search}%`));
        }

        const rows = await db
            .select({
                id: apps.id,
                appId: apps.appId,
                name: apps.name,
                description: apps.description,
                icon: apps.icon,
                category: apps.category,
                status: apps.status,
                createdAt: apps.createdAt,
                updatedAt: apps.updatedAt,
                developerId: apps.developerId,
                developerName: developers.name,
                developerEmail: developers.email,
            })
            .from(apps)
            .innerJoin(developers, eq(apps.developerId, developers.id))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .limit(limit)
            .offset(offset);

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(apps)
            .innerJoin(developers, eq(apps.developerId, developers.id))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .get();

        return { apps: rows, total: countResult?.count ?? 0 };
    });

    /**
     * PATCH /api/admin/apps/:appId/review
     * Approve or reject an app.
     */
    fastify.patch('/apps/:appId/review', {
        onRequest: [fastify.authenticate, requireAdmin],
        schema: {
            description: 'Approve or reject an app (admin only)',
            tags: ['admin'],
            security: [{ bearerAuth: [] }],
            params: {
                type: 'object',
                required: ['appId'],
                properties: { appId: { type: 'string' } },
            },
            body: {
                type: 'object',
                required: ['action'],
                properties: {
                    action: { type: 'string', enum: ['approve', 'reject'] },
                    notes: { type: 'string' },
                },
            },
        },
    }, async (request: any, reply: any) => {
        const { appId } = request.params as { appId: string };
        const input = reviewSchema.parse(request.body);
        const db = getDatabase();

        const app = await db.select().from(apps).where(eq(apps.appId, appId)).get();
        if (!app) {
            reply.code(404).send({ error: 'App not found' });
            return;
        }

        const newStatus = input.action === 'approve' ? 'approved' : 'rejected';
        const now = new Date();

        await db.update(apps)
            .set({
                status: newStatus as any,
                isPublic: input.action === 'approve',
                updatedAt: now,
            })
            .where(eq(apps.id, app.id));

        // Find the latest version for review record (if any)
        const latestVersion = await db
            .select({ id: versions.id })
            .from(versions)
            .where(eq(versions.appId, app.id))
            .get();

        if (latestVersion) {
            await upsertReviewRecord(db, latestVersion.id, request.user.id, input.action, input.notes, now);
        }

        return { success: true, status: newStatus };
    });

    /**
     * GET /api/admin/developers
     * All registered developers with app count and suspended flag.
     */
    fastify.get('/developers', {
        onRequest: [fastify.authenticate, requireAdmin],
        schema: {
            description: 'List all developers (admin only)',
            tags: ['admin'],
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    search: { type: 'string' },
                    limit: { type: 'number' },
                    offset: { type: 'number' },
                },
            },
        },
    }, async (request: any) => {
        const db = getDatabase();
        const { search, limit = 50, offset = 0 } = request.query as {
            search?: string;
            limit?: number;
            offset?: number;
        };

        const condition = search
            ? and(eq(developers.role, 'developer'), like(developers.name, `%${search}%`))
            : eq(developers.role, 'developer');

        const rows = await db
            .select({
                id: developers.id,
                email: developers.email,
                name: developers.name,
                organization: developers.organization,
                role: developers.role,
                suspended: developers.suspended,
                verified: developers.verified,
                createdAt: developers.createdAt,
            })
            .from(developers)
            .where(condition)
            .limit(limit)
            .offset(offset);

        // Attach app counts
        const ids = rows.map((d) => d.id);
        let appCounts: Record<string, number> = {};
        if (ids.length > 0) {
            const counts = await db
                .select({ developerId: apps.developerId, count: sql<number>`count(*)` })
                .from(apps)
                .where(inArray(apps.developerId, ids))
                .groupBy(apps.developerId);
            for (const c of counts) {
                appCounts[c.developerId] = c.count;
            }
        }

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(developers)
            .where(condition)
            .get();

        return {
            developers: rows.map((d) => ({ ...d, appCount: appCounts[d.id] ?? 0 })),
            total: countResult?.count ?? 0,
        };
    });

    /**
     * GET /api/admin/developers/:id
     * Developer detail with their apps list.
     */
    fastify.get('/developers/:id', {
        onRequest: [fastify.authenticate, requireAdmin],
        schema: {
            description: 'Developer detail (admin only)',
            tags: ['admin'],
            security: [{ bearerAuth: [] }],
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
            },
        },
    }, async (request: any, reply: any) => {
        const { id } = request.params as { id: string };
        const db = getDatabase();

        const developer = await db
            .select({
                id: developers.id,
                email: developers.email,
                name: developers.name,
                organization: developers.organization,
                role: developers.role,
                suspended: developers.suspended,
                verified: developers.verified,
                createdAt: developers.createdAt,
            })
            .from(developers)
            .where(eq(developers.id, id))
            .get();

        if (!developer) {
            reply.code(404).send({ error: 'Developer not found' });
            return;
        }

        const devApps = await db
            .select({
                id: apps.id,
                name: apps.name,
                appId: apps.appId,
                status: apps.status,
                category: apps.category,
                createdAt: apps.createdAt,
            })
            .from(apps)
            .where(eq(apps.developerId, id));

        // Total downloads for this developer
        let totalDownloads = 0;
        if (devApps.length > 0) {
            const appIds = devApps.map((a) => a.id);
            const dlResult = await db
                .select({ count: sql<number>`count(*)` })
                .from(downloads)
                .innerJoin(versions, eq(downloads.versionId, versions.id))
                .where(inArray(versions.appId, appIds))
                .get();
            totalDownloads = dlResult?.count ?? 0;
        }

        return { developer, apps: devApps, totalDownloads };
    });

    /**
     * PATCH /api/admin/developers/:id/suspend
     * Toggle suspended status on a developer account.
     */
    fastify.patch('/developers/:id/suspend', {
        onRequest: [fastify.authenticate, requireAdmin],
        schema: {
            description: 'Suspend or unsuspend a developer account (admin only)',
            tags: ['admin'],
            security: [{ bearerAuth: [] }],
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
            },
            body: {
                type: 'object',
                required: ['suspended'],
                properties: { suspended: { type: 'boolean' } },
            },
        },
    }, async (request: any, reply: any) => {
        const { id } = request.params as { id: string };
        const { suspended } = request.body as { suspended: boolean };
        const db = getDatabase();

        // Prevent admins from suspending themselves
        if (id === request.user.id) {
            reply.code(400).send({ error: 'Cannot suspend your own account' });
            return;
        }

        const developer = await db.select({ id: developers.id }).from(developers).where(eq(developers.id, id)).get();
        if (!developer) {
            reply.code(404).send({ error: 'Developer not found' });
            return;
        }

        await db.update(developers)
            .set({ suspended, updatedAt: new Date() })
            .where(eq(developers.id, id));

        return { success: true, suspended };
    });
};
