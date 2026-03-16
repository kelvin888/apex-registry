/**
 * Versions Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initDatabase, closeDatabase, runMigrations } from '../db';
import * as authService from '../services/auth';
import * as appsService from '../services/apps';
import * as versionsService from '../services/versions';
import { type Config } from '../config';

describe('Versions Service', () => {
  let dbPath: string;
  let tempDir: string;
  let developerId: string;
  let appId: string;
  let config: Config;

  beforeEach(async () => {
    // Create temp directories
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-server-test-'));
    dbPath = path.join(tempDir, 'test.db');
    const storagePath = path.join(tempDir, 'packages');

    initDatabase({ path: dbPath });
    runMigrations();

    config = {
      host: '0.0.0.0',
      port: 4000,
      nodeEnv: 'test',
      databasePath: dbPath,
      jwtSecret: 'test-secret-key-for-testing-only!',
      jwtExpiresIn: '7d',
      storagePath,
      maxPackageSize: 50 * 1024 * 1024,
      rateLimit: 100,
      rateLimitWindow: 60000,
      corsOrigins: ['*'],
      logLevel: 'error',
    };

    // Create a developer and app
    const { developer } = await authService.registerDeveloper({
      email: 'test@example.com',
      password: 'password123',
      name: 'Test Developer',
    });
    developerId = developer.id;

    const app = await appsService.createApp(developerId, {
      appId: 'com.example.testapp',
      name: 'Test App',
    });
    appId = app.id;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('createVersion', () => {
    it('should create a new version', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
        changelog: 'Initial release',
        minHostVersion: '1.0.0',
        permissions: ['network', 'storage'],
      });

      expect(version).toBeDefined();
      expect(version.version).toBe('1.0.0');
      expect(version.versionCode).toBe(1);
      expect(version.changelog).toBe('Initial release');
      expect(version.status).toBe('uploading');
    });

    it('should auto-increment version code', async () => {
      await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
      const v2 = await versionsService.createVersion(appId, developerId, { version: '1.0.1' });
      const v3 = await versionsService.createVersion(appId, developerId, { version: '1.1.0' });

      expect(v2.versionCode).toBe(2);
      expect(v3.versionCode).toBe(3);
    });

    it('should reject invalid semver', async () => {
      await expect(
        versionsService.createVersion(appId, developerId, { version: 'invalid' })
      ).rejects.toThrow('Invalid version format');
    });

    it('should reject duplicate versions', async () => {
      await versionsService.createVersion(appId, developerId, { version: '1.0.0' });

      await expect(
        versionsService.createVersion(appId, developerId, { version: '1.0.0' })
      ).rejects.toThrow('already exists');
    });

    it('should reject unauthorized developers', async () => {
      await expect(
        versionsService.createVersion(appId, 'other-developer-id', { version: '1.0.0' })
      ).rejects.toThrow('App not found or access denied');
    });
  });

  describe('uploadPackage', () => {
    it('should upload package file', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      const packageContent = Buffer.from('fake package content');
      const updated = await versionsService.uploadPackage(
        version.id,
        developerId,
        {
          buffer: packageContent,
          filename: 'package.map',
        },
        config
      );

      expect(updated.status).toBe('ready');
      expect(updated.packageSize).toBe(packageContent.length);
      expect(updated.packageHash).toBeDefined();
      expect(updated.packagePath).toBeDefined();
    });

    it('should reject non-.map files', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      await expect(
        versionsService.uploadPackage(
          version.id,
          developerId,
          {
            buffer: Buffer.from('content'),
            filename: 'package.zip',
          },
          config
        )
      ).rejects.toThrow('must be a .map file');
    });

    it('should reject oversized packages', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      const smallConfig = { ...config, maxPackageSize: 10 };

      await expect(
        versionsService.uploadPackage(
          version.id,
          developerId,
          {
            buffer: Buffer.alloc(100),
            filename: 'package.map',
          },
          smallConfig
        )
      ).rejects.toThrow('Package too large');
    });

    it('should reject double uploads', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      await versionsService.uploadPackage(
        version.id,
        developerId,
        { buffer: Buffer.from('content'), filename: 'package.map' },
        config
      );

      await expect(
        versionsService.uploadPackage(
          version.id,
          developerId,
          { buffer: Buffer.from('content2'), filename: 'package.map' },
          config
        )
      ).rejects.toThrow('already has a package');
    });
  });

  describe('getVersionById', () => {
    it('should return version with download count', async () => {
      const created = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      const version = await versionsService.getVersionById(created.id);

      expect(version).not.toBeNull();
      expect(version!.version).toBe('1.0.0');
      expect(version!.downloadCount).toBe(0);
    });
  });

  describe('listVersions', () => {
    it('should list all versions for app', async () => {
      await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
      await versionsService.createVersion(appId, developerId, { version: '1.1.0' });
      await versionsService.createVersion(appId, developerId, { version: '2.0.0' });

      const versions = await versionsService.listVersions(appId);

      expect(versions.length).toBe(3);
      // Should be sorted by versionCode descending
      expect(versions[0].version).toBe('2.0.0');
      expect(versions[1].version).toBe('1.1.0');
      expect(versions[2].version).toBe('1.0.0');
    });
  });

  describe('getLatestVersion', () => {
    it('should return latest ready version', async () => {
      const v1 = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
      await versionsService.uploadPackage(
        v1.id,
        developerId,
        { buffer: Buffer.from('v1'), filename: 'package.map' },
        config
      );

      const v2 = await versionsService.createVersion(appId, developerId, { version: '2.0.0' });
      await versionsService.uploadPackage(
        v2.id,
        developerId,
        { buffer: Buffer.from('v2'), filename: 'package.map' },
        config
      );

      const latest = await versionsService.getLatestVersion(appId);

      expect(latest).not.toBeNull();
      expect(latest!.version).toBe('2.0.0');
    });

    it('should return null if no ready versions', async () => {
      await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
      // Version is still in 'uploading' status

      const latest = await versionsService.getLatestVersion(appId);
      expect(latest).toBeNull();
    });
  });

  describe('deleteVersion', () => {
    it('should delete version and package', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      await versionsService.uploadPackage(
        version.id,
        developerId,
        { buffer: Buffer.from('content'), filename: 'package.map' },
        config
      );

      await versionsService.deleteVersion(version.id, developerId, config);

      const deleted = await versionsService.getVersionById(version.id);
      expect(deleted).toBeNull();
    });

    it('should reject unauthorized deletion', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      await expect(
        versionsService.deleteVersion(version.id, 'other-developer-id', config)
      ).rejects.toThrow('Access denied');
    });
  });

  describe('recordDownload', () => {
    it('should record download analytics', async () => {
      const version = await versionsService.createVersion(appId, developerId, {
        version: '1.0.0',
      });

      await versionsService.uploadPackage(
        version.id,
        developerId,
        { buffer: Buffer.from('content'), filename: 'package.map' },
        config
      );

      await versionsService.recordDownload(version.id, {
        hostAppId: 'com.example.host',
        hostVersion: '1.0.0',
        platform: 'ios',
        region: 'NG',
        ipHash: 'abc123',
      });

      const updated = await versionsService.getVersionById(version.id);
      expect(updated!.downloadCount).toBe(1);
    });
  });
});
