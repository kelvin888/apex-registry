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
import AdmZip from 'adm-zip';
import { getDatabase, versions, apps, downloads, reviews, certificates, type Version, type NewVersion } from '../db';
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
 * Recomputes the content hash of a package exactly as the CLI does:
 * SHA-256 of all (entryName + data) pairs, sorted by name,
 * excluding manifest.json and signature.sig.
 */
function recomputeContentHash(zip: AdmZip): string {
  const hash = crypto.createHash('sha256');
  const entries = zip.getEntries()
    .filter(e => !e.isDirectory && e.entryName !== 'manifest.json' && e.entryName !== 'signature.sig')
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
  for (const entry of entries) {
    hash.update(entry.entryName);
    hash.update(entry.getData());
  }
  return hash.digest('hex');
}

function validateManifestPermissions(zip: AdmZip): void {
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error('Invalid package: missing manifest.json. Build your app with `apex build` first.');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(zip.readAsText('manifest.json'));
  } catch {
    throw new Error('Invalid package: manifest.json is not valid JSON.');
  }

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid package: manifest.json must be a JSON object.');
  }

  const permissions = (manifest as { permissions?: unknown }).permissions;
  if (permissions === undefined) {
    return;
  }

  if (!Array.isArray(permissions)) {
    throw new Error('Invalid package: manifest.permissions must be an array of strings.');
  }

  const invalidIndex = permissions.findIndex((entry) => typeof entry !== 'string');
  if (invalidIndex !== -1) {
    throw new Error(
      `Invalid package: manifest.permissions[${invalidIndex}] must be a string. Object-style permissions are not supported in published manifests.`
    );
  }
}

/**
 * Create a new version
 */
export async function createVersion(appId: string, developerId: string, input: CreateVersionInput): Promise<Version> {
  const db = getDatabase();

  // Verify app ownership
  const [app] = await db.select().from(apps)
    .where(and(eq(apps.id, appId), eq(apps.developerId, developerId)))
    .limit(1);

  if (!app) {
    throw new Error('App not found or access denied');
  }

  // Validate semver
  if (!semver.valid(input.version)) {
    throw new Error('Invalid version format. Use semantic versioning (e.g., 1.0.0)');
  }

  // Check version doesn't exist
  const [existing] = await db.select().from(versions)
    .where(and(eq(versions.appId, appId), eq(versions.version, input.version)))
    .limit(1);

  if (existing) {
    await db.delete(versions).where(eq(versions.id, existing.id));
  }

  // Get next version code
  const [latestVersion] = await db.select()
    .from(versions)
    .where(eq(versions.appId, appId))
    .orderBy(desc(versions.versionCode))
    .limit(1);

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
  const [version] = await db.select().from(versions)
    .where(eq(versions.id, versionId))
    .limit(1);

  if (!version) {
    throw new Error('Version not found');
  }

  const [app] = await db.select().from(apps)
    .where(and(eq(apps.id, version.appId), eq(apps.developerId, developerId)))
    .limit(1);

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

  // Validate ZIP structure: must be a valid ZIP containing manifest.json
  let zip: AdmZip;
  try {
    zip = new AdmZip(input.buffer);
  } catch {
    throw new Error('Package is not a valid ZIP archive');
  }
  validateManifestPermissions(zip);

  // ── Signature verification ────────────────────────────────────────────────
  let signatureToStore: string | null = null;
  const sigEntry = zip.getEntry('signature.sig');
  if (sigEntry) {
    let sigData: { algorithm?: string; keyId?: string; timestamp?: string; contentHash?: string; signature?: string } | undefined;
    try {
      sigData = JSON.parse(sigEntry.getData().toString('utf-8'));
    } catch {
      throw new Error('Package signature.sig is not valid JSON');
    }
    if (!sigData || typeof sigData.signature !== 'string' || typeof sigData.contentHash !== 'string') {
      throw new Error('Package signature.sig is malformed: missing signature or contentHash fields');
    }

    // Recompute content hash from ZIP to detect tampering
    const computedHash = recomputeContentHash(zip);

    // Look up the developer's registered, non-expired certificates
    const now = new Date();
    const devCerts = await db.select().from(certificates)
      .where(eq(certificates.developerId, developerId));
    const activeCerts = devCerts.filter(c => !c.expiresAt || c.expiresAt > now);

    if (activeCerts.length === 0) {
      throw new Error(
        'Package is signed but no certificates are registered. ' +
        'Register your public key first with `apex keys register`.',
      );
    }

    let verified = false;
    for (const cert of activeCerts) {
      try {
        const verifier = crypto.createVerify('SHA256');
        verifier.update(computedHash);
        if (verifier.verify(cert.publicKey, sigData.signature, 'base64')) {
          verified = true;
          break;
        }
      } catch {
        // Bad key format or algorithm mismatch — try the next cert
      }
    }

    if (!verified) {
      throw new Error(
        'Package signature verification failed: ' +
        'signature does not match any registered certificate.',
      );
    }

    signatureToStore = JSON.stringify(sigData);
  }

  // Calculate hash
  const hash = crypto.createHash('sha256').update(input.buffer).digest('hex');

  // Store package bytes in the database (survives Railway redeployments).
  // Also write to filesystem as a fallback / legacy path if STORAGE_PATH is set.
  let packagePath: string | null = null;
  try {
    const packageDir = getStoragePath(config, app.appId, version.version);
    if (!fs.existsSync(packageDir)) {
      fs.mkdirSync(packageDir, { recursive: true });
    }
    packagePath = path.join(packageDir, 'package.map');
    fs.writeFileSync(packagePath, input.buffer);
  } catch {
    // Filesystem may be ephemeral (Railway) — DB storage is the source of truth
  }

  // Update version — store raw bytes in package_data
  const updated = await db.update(versions)
    .set({
      status: 'processing',
      packagePath,
      packageData: input.buffer,
      packageSize: input.buffer.length,
      packageHash: hash,
      signature: signatureToStore,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .where(eq(versions.id, versionId))
    .returning();

  // Process package (in production, this would be a background job)
  await processPackage(versionId);

  // Extract and store icon from package if manifest contains a bundled icon path
  await extractAndStoreIcon(zip, app, config);

  // Re-fetch the version to return the final status set by processPackage
  const [processed] = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
  return processed as Version;
}

/**
 * Process uploaded package
 */
async function processPackage(versionId: string): Promise<void> {
  const db = getDatabase();

  try {
    // Mark version as ready, then move the parent app to pending review
    await db.update(versions)
      .set({ status: 'ready' })
      .where(eq(versions.id, versionId));

    const [version] = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
    if (version) {
      // This is a private/internal registry — auto-approve all published apps immediately.
      // Set AUTO_APPROVE_PUBLISH=false in the environment to require manual approval instead.
      const requireApproval = process.env.AUTO_APPROVE_PUBLISH === 'false';
      await db.update(apps)
        .set(requireApproval
          ? { status: 'pending', updatedAt: new Date() }
          : { status: 'approved', isPublic: true, updatedAt: new Date() })
        .where(eq(apps.id, version.appId));
    }
  } catch (error) {
    await db.update(versions)
      .set({ status: 'failed' })
      .where(eq(versions.id, versionId));
    throw error;
  }
}

const ICON_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Extract bundled icon from .map package and store it alongside the app.
 * If manifest.info.icon is a relative file path (not a URL), the icon file
 * is pulled from the ZIP archive, stored on disk at
 * {storagePath}/{appId}/icon.{ext}, and the app DB row is updated so
 * registry endpoints return a deterministic icon URL.
 */
async function extractAndStoreIcon(
  zip: AdmZip,
  app: { id: string; appId: string },
  config: Config,
): Promise<void> {
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) return;

  let manifest: { info?: { icon?: string } };
  try {
    manifest = JSON.parse(zip.readAsText('manifest.json'));
  } catch {
    return;
  }

  const iconRef = manifest?.info?.icon;
  if (!iconRef) return;

  // If it's an absolute URL already, just store the URL in the DB
  if (/^https?:\/\//i.test(iconRef)) {
    const db = getDatabase();
    await db.update(apps)
      .set({ icon: iconRef, updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    return;
  }

  // Bundled icon — extract from ZIP
  const ext = path.extname(iconRef).toLowerCase();
  if (!ICON_EXTENSIONS.has(ext)) return;

  const iconEntry = zip.getEntry(iconRef);
  if (!iconEntry) return;

  const iconData = iconEntry.getData();
  const iconDir = getStoragePath(config, app.appId);
  const iconFilename = `icon${ext}`;
  const iconPath = path.join(iconDir, iconFilename);

  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
  }
  fs.writeFileSync(iconPath, iconData);

  // Store a sentinel value; the registry route will build the full URL per-request
  const db = getDatabase();
  await db.update(apps)
    .set({ icon: `local:${iconFilename}`, updatedAt: new Date() })
    .where(eq(apps.id, app.id));
}

/**
 * Get version by ID
 */
export async function getVersionById(id: string): Promise<VersionWithDownloads | null> {
  const db = getDatabase();

  const [version] = await db.select().from(versions).where(eq(versions.id, id)).limit(1);
  if (!version) {
    return null;
  }

  const [downloadCount] = await db.select({ count: sql<number>`count(*)` })
    .from(downloads)
    .where(eq(downloads.versionId, id))
    .limit(1);

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
      const [downloadCount] = await db.select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(eq(downloads.versionId, version.id))
        .limit(1);

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

  const [version] = await db.select()
    .from(versions)
    .where(and(eq(versions.appId, appId), eq(versions.status, 'ready')))
    .orderBy(desc(versions.versionCode))
    .limit(1);

  return version || null;
}

/**
 * Delete version
 */
export async function deleteVersion(id: string, developerId: string, config: Config): Promise<boolean> {
  const db = getDatabase();

  const [version] = await db.select().from(versions).where(eq(versions.id, id)).limit(1);
  if (!version) {
    throw new Error('Version not found');
  }

  const [app] = await db.select().from(apps)
    .where(and(eq(apps.id, version.appId), eq(apps.developerId, developerId)))
    .limit(1);

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

  // Delete child rows in FK order: reviews → downloads → version
  await db.delete(reviews).where(eq(reviews.versionId, id));
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
