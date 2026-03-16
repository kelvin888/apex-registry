/**
 * Versions Service
 *
 * Manages app versions and package uploads
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as semver from 'semver';
import { getDatabase, versions, apps, downloads, type Version, type NewVersion } from '../db';
import { getStoragePath, type Config } from '../config';

export interface CreateVersionInput {
  version: string;
  changelog?: string;
  minHostVersion?: string;
  permissions?: string[];
}

export interface UploadPackageInput {
  buffer: Buffer;
  filename: string;
  metadata?: Record<string, unknown>;
}

export interface VersionWithDownloads extends Version {
  downloadCount: number;
}

/**
 * Create a new version
 */
export async function createVersion(appId: string, developerId: string, input: CreateVersionInput): Promise<Version> {
  const db = getDatabase();

  // Verify app ownership
  const app = await db.select().from(apps)
    .where(and(eq(apps.id, appId), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('App not found or access denied');
  }

  // Validate semver
  if (!semver.valid(input.version)) {
    throw new Error('Invalid version format. Use semantic versioning (e.g., 1.0.0)');
  }

  // Check version doesn't exist
  const existing = await db.select().from(versions)
    .where(and(eq(versions.appId, appId), eq(versions.version, input.version)))
    .get();

  if (existing) {
    throw new Error(`Version ${input.version} already exists`);
  }

  // Get next version code
  const latestVersion = await db.select()
    .from(versions)
    .where(eq(versions.appId, appId))
    .orderBy(desc(versions.versionCode))
    .limit(1)
    .get();

  const versionCode = (latestVersion?.versionCode || 0) + 1;

  const now = new Date();
  const version: NewVersion = {
    id: nanoid(),
    appId,
    version: input.version,
    versionCode,
    changelog: input.changelog,
    minHostVersion: input.minHostVersion,
    permissions: input.permissions ? JSON.stringify(input.permissions) : null,
    status: 'uploading',
    createdAt: now,
  };

  await db.insert(versions).values(version);

  return version as Version;
}

/**
 * Upload package for version
 */
export async function uploadPackage(
  versionId: string,
  developerId: string,
  input: UploadPackageInput,
  config: Config
): Promise<Version> {
  const db = getDatabase();

  // Get version and verify ownership
  const version = await db.select().from(versions)
    .where(eq(versions.id, versionId))
    .get();

  if (!version) {
    throw new Error('Version not found');
  }

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, version.appId), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('Access denied');
  }

  if (version.status !== 'uploading') {
    throw new Error('Version already has a package');
  }

  // Check file size
  if (input.buffer.length > config.maxPackageSize) {
    throw new Error(`Package too large. Maximum size is ${config.maxPackageSize / 1024 / 1024}MB`);
  }

  // Validate package (should be a .map file)
  if (!input.filename.endsWith('.map')) {
    throw new Error('Package must be a .map file');
  }

  // Calculate hash
  const hash = crypto.createHash('sha256').update(input.buffer).digest('hex');

  // Store package
  const packageDir = getStoragePath(config, app.appId, version.version);
  if (!fs.existsSync(packageDir)) {
    fs.mkdirSync(packageDir, { recursive: true });
  }

  const packagePath = path.join(packageDir, 'package.map');
  fs.writeFileSync(packagePath, input.buffer);

  // Update version
  const updated = await db.update(versions)
    .set({
      status: 'processing',
      packagePath,
      packageSize: input.buffer.length,
      packageHash: hash,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .where(eq(versions.id, versionId))
    .returning();

  // Process package (in production, this would be a background job)
  await processPackage(versionId);

  return updated[0];
}

/**
 * Process uploaded package
 */
async function processPackage(versionId: string): Promise<void> {
  const db = getDatabase();

  try {
    // In production, validate package contents, extract metadata, generate signature
    // For now, just mark as ready

    await db.update(versions)
      .set({ status: 'ready' })
      .where(eq(versions.id, versionId));
  } catch (error) {
    await db.update(versions)
      .set({ status: 'failed' })
      .where(eq(versions.id, versionId));
    throw error;
  }
}

/**
 * Get version by ID
 */
export async function getVersionById(id: string): Promise<VersionWithDownloads | null> {
  const db = getDatabase();

  const version = await db.select().from(versions).where(eq(versions.id, id)).get();
  if (!version) {
    return null;
  }

  const downloadCount = await db.select({ count: sql<number>`count(*)` })
    .from(downloads)
    .where(eq(downloads.versionId, id))
    .get();

  return {
    ...version,
    downloadCount: downloadCount?.count || 0,
  };
}

/**
 * List versions for app
 */
export async function listVersions(appId: string): Promise<VersionWithDownloads[]> {
  const db = getDatabase();

  const versionsList = await db.select()
    .from(versions)
    .where(eq(versions.appId, appId))
    .orderBy(desc(versions.versionCode));

  return Promise.all(
    versionsList.map(async (version) => {
      const downloadCount = await db.select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(eq(downloads.versionId, version.id))
        .get();

      return {
        ...version,
        downloadCount: downloadCount?.count || 0,
      };
    })
  );
}

/**
 * Get latest version for app
 */
export async function getLatestVersion(appId: string): Promise<Version | null> {
  const db = getDatabase();

  const version = await db.select()
    .from(versions)
    .where(and(eq(versions.appId, appId), eq(versions.status, 'ready')))
    .orderBy(desc(versions.versionCode))
    .limit(1)
    .get();

  return version || null;
}

/**
 * Delete version
 */
export async function deleteVersion(id: string, developerId: string, config: Config): Promise<boolean> {
  const db = getDatabase();

  const version = await db.select().from(versions).where(eq(versions.id, id)).get();
  if (!version) {
    throw new Error('Version not found');
  }

  const app = await db.select().from(apps)
    .where(and(eq(apps.id, version.appId), eq(apps.developerId, developerId)))
    .get();

  if (!app) {
    throw new Error('Access denied');
  }

  // Don't delete if it's the only ready version and app is published
  if (version.status === 'ready' && app.isPublic) {
    const readyVersions = await db.select()
      .from(versions)
      .where(and(eq(versions.appId, version.appId), eq(versions.status, 'ready')));

    if (readyVersions.length <= 1) {
      throw new Error('Cannot delete the only published version');
    }
  }

  // Delete package file
  if (version.packagePath && fs.existsSync(version.packagePath)) {
    fs.unlinkSync(version.packagePath);

    // Try to remove empty directories
    const dir = path.dirname(version.packagePath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  }

  // Delete downloads
  await db.delete(downloads).where(eq(downloads.versionId, id));

  // Delete version
  await db.delete(versions).where(eq(versions.id, id));

  return true;
}

/**
 * Sign version package
 */
export async function signVersion(id: string, signature: string): Promise<Version> {
  const db = getDatabase();

  const updated = await db.update(versions)
    .set({ signature })
    .where(eq(versions.id, id))
    .returning();

  return updated[0];
}

/**
 * Record download
 */
export async function recordDownload(
  versionId: string,
  info: {
    hostAppId?: string;
    hostVersion?: string;
    platform?: string;
    region?: string;
    ipHash?: string;
  }
): Promise<void> {
  const db = getDatabase();

  await db.insert(downloads).values({
    id: nanoid(),
    versionId,
    ...info,
    createdAt: new Date(),
  });
}

/**
 * Get download stats
 */
export async function getDownloadStats(appId: string, days: number = 30) {
  const db = getDatabase();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await db.select({
    date: sql<string>`date(created_at / 1000, 'unixepoch')`,
    platform: downloads.platform,
    count: sql<number>`count(*)`,
  })
    .from(downloads)
    .innerJoin(versions, eq(downloads.versionId, versions.id))
    .where(and(
      eq(versions.appId, appId),
      sql`${downloads.createdAt} >= ${cutoff}`
    ))
    .groupBy(sql`date(created_at / 1000, 'unixepoch')`, downloads.platform);

  return stats;
}
