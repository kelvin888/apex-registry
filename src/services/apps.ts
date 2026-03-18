/**
 * Apps Service
 *
 * Manages mini-app registration and metadata
 */

import { eq, and, desc, like, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, apps, versions, downloads, type App, type NewApp, type Version } from '../db';

export interface CreateAppInput {
  appId: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
}

export interface UpdateAppInput {
  name?: string;
  description?: string;
  icon?: string;
  category?: string;
}

export interface ListAppsOptions {
  developerId?: string;
  status?: App['status'];
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  publicOnly?: boolean;
}

export interface AppWithStats extends App {
  latestVersion?: string;
  totalDownloads: number;
}

/**
 * Create a new app
 */
export async function createApp(developerId: string, input: CreateAppInput): Promise<App> {
  const db = getDatabase();

  // Validate appId format (reverse domain)
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(input.appId)) {
    throw new Error('Invalid appId format. Use reverse domain notation (e.g., com.example.myapp)');
  }

  // Check if appId exists
  const existing = await db.select().from(apps).where(eq(apps.appId, input.appId)).get();
  if (existing) {
    throw new Error('App ID already registered');
  }

  const autoApprove = process.env.APEX_AUTO_APPROVE === 'true';

  const now = new Date();
  const app: NewApp = {
    id: nanoid(),
    appId: input.appId,
    developerId,
    name: input.name,
    description: input.description,
    icon: input.icon,
    category: input.category,
    status: autoApprove ? 'approved' : 'draft',
    isPublic: autoApprove,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(apps).values(app);

  return app as App;
}

/**
 * Get app by ID
 */
export async function getAppById(id: string): Promise<App | null> {
  const db = getDatabase();
  const app = await db.select().from(apps).where(eq(apps.id, id)).get();
  return app || null;
}

/**
 * Get app by appId
 */
export async function getAppByAppId(appId: string): Promise<App | null> {
  const db = getDatabase();
  const app = await db.select().from(apps).where(eq(apps.appId, appId)).get();
  return app || null;
}

/**
 * Update app
 */
export async function updateApp(id: string, developerId: string, input: UpdateAppInput): Promise<App> {
  const db = getDatabase();

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, id), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  const updated = await db.update(apps)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(apps.id, id))
    .returning();

  return updated[0];
}

/**
 * Delete app
 */
export async function deleteApp(id: string, developerId: string): Promise<boolean> {
  const db = getDatabase();

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, id), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  // Check for published versions
  const publishedVersions = await db.select().from(versions)
    .where(and(eq(versions.appId, id), eq(versions.status, 'ready')))
    .get();

  if (publishedVersions) {
    throw new Error('Cannot delete app with published versions');
  }

  await db.delete(apps).where(eq(apps.id, id));

  return true;
}

/**
 * List apps
 */
export async function listApps(options: ListAppsOptions = {}): Promise<{ apps: AppWithStats[]; total: number }> {
  const db = getDatabase();
  const { limit = 20, offset = 0 } = options;

  // Build where conditions
  const conditions = [];

  if (options.developerId) {
    conditions.push(eq(apps.developerId, options.developerId));
  }

  if (options.status) {
    conditions.push(eq(apps.status, options.status));
  }

  if (options.category) {
    conditions.push(eq(apps.category, options.category));
  }

  if (options.publicOnly) {
    conditions.push(eq(apps.isPublic, true));
    conditions.push(eq(apps.status, 'approved'));
  }

  if (options.search) {
    conditions.push(
      or(
        like(apps.name, `%${options.search}%`),
        like(apps.appId, `%${options.search}%`),
        like(apps.description, `%${options.search}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get apps
  const appsList = await db.select()
    .from(apps)
    .where(whereClause)
    .orderBy(desc(apps.updatedAt))
    .limit(limit)
    .offset(offset);

  // Get total count
  const countResult = await db.select({ count: sql<number>`count(*)` })
    .from(apps)
    .where(whereClause)
    .get();

  const total = countResult?.count || 0;

  // Enrich with stats
  const enrichedApps: AppWithStats[] = await Promise.all(
    appsList.map(async (app) => {
      // Get latest version
      const latestVersion = await db.select()
        .from(versions)
        .where(and(eq(versions.appId, app.id), eq(versions.status, 'ready')))
        .orderBy(desc(versions.versionCode))
        .limit(1)
        .get();

      // Get download count
      const downloadCount = await db.select({ count: sql<number>`count(*)` })
        .from(downloads)
        .innerJoin(versions, eq(downloads.versionId, versions.id))
        .where(eq(versions.appId, app.id))
        .get();

      return {
        ...app,
        latestVersion: latestVersion?.version,
        totalDownloads: downloadCount?.count || 0,
      };
    })
  );

  return { apps: enrichedApps, total };
}

/**
 * Submit app for review
 */
export async function submitForReview(id: string, developerId: string): Promise<App> {
  const db = getDatabase();

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, id), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  if (app.status !== 'draft' && app.status !== 'rejected') {
    throw new Error('App cannot be submitted in current state');
  }

  // Check for at least one ready version
  const readyVersion = await db.select().from(versions)
    .where(and(eq(versions.appId, id), eq(versions.status, 'ready')))
    .get();

  if (!readyVersion) {
    throw new Error('App must have at least one ready version before submission');
  }

  const updated = await db.update(apps)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(apps.id, id))
    .returning();

  return updated[0];
}

/**
 * Publish app (make public)
 */
export async function publishApp(id: string, developerId: string): Promise<App> {
  const db = getDatabase();

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, id), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  if (app.status !== 'approved') {
    throw new Error('Only approved apps can be published');
  }

  const updated = await db.update(apps)
    .set({ isPublic: true, updatedAt: new Date() })
    .where(eq(apps.id, id))
    .returning();

  return updated[0];
}

/**
 * Unpublish app (make private)
 */
export async function unpublishApp(id: string, developerId: string): Promise<App> {
  const db = getDatabase();

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, id), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  const updated = await db.update(apps)
    .set({ isPublic: false, updatedAt: new Date() })
    .where(eq(apps.id, id))
    .returning();

  return updated[0];
}
