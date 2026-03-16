/**
 * Apps Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initDatabase, closeDatabase, runMigrations } from '../db';
import * as authService from '../services/auth';
import * as appsService from '../services/apps';

describe('Apps Service', () => {
  let dbPath: string;
  let developerId: string;

  beforeEach(async () => {
    // Create temp database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-server-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDatabase({ path: dbPath });
    runMigrations();

    // Create a developer
    const { developer } = await authService.registerDeveloper({
      email: 'test@example.com',
      password: 'password123',
      name: 'Test Developer',
    });
    developerId = developer.id;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  describe('createApp', () => {
    it('should create a new app', async () => {
      const app = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
        description: 'A test application',
        category: 'utilities',
      });

      expect(app).toBeDefined();
      expect(app.appId).toBe('com.example.testapp');
      expect(app.name).toBe('Test App');
      expect(app.description).toBe('A test application');
      expect(app.status).toBe('draft');
      expect(app.isPublic).toBe(false);
    });

    it('should reject invalid appId format', async () => {
      await expect(
        appsService.createApp(developerId, {
          appId: 'invalid-app-id',
          name: 'Test App',
        })
      ).rejects.toThrow('Invalid appId format');
    });

    it('should reject duplicate appId', async () => {
      await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await expect(
        appsService.createApp(developerId, {
          appId: 'com.example.testapp',
          name: 'Another App',
        })
      ).rejects.toThrow('App ID already registered');
    });
  });

  describe('getAppById', () => {
    it('should return app by ID', async () => {
      const created = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      const app = await appsService.getAppById(created.id);

      expect(app).not.toBeNull();
      expect(app!.appId).toBe('com.example.testapp');
    });

    it('should return null for unknown ID', async () => {
      const app = await appsService.getAppById('unknown-id');
      expect(app).toBeNull();
    });
  });

  describe('getAppByAppId', () => {
    it('should return app by appId', async () => {
      await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      const app = await appsService.getAppByAppId('com.example.testapp');

      expect(app).not.toBeNull();
      expect(app!.name).toBe('Test App');
    });
  });

  describe('updateApp', () => {
    it('should update app metadata', async () => {
      const created = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      const updated = await appsService.updateApp(created.id, developerId, {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.description).toBe('Updated description');
    });

    it('should reject updates from other developers', async () => {
      const created = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await expect(
        appsService.updateApp(created.id, 'other-developer-id', {
          name: 'Hacked Name',
        })
      ).rejects.toThrow('App not found or access denied');
    });
  });

  describe('deleteApp', () => {
    it('should delete app', async () => {
      const created = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await appsService.deleteApp(created.id, developerId);

      const app = await appsService.getAppById(created.id);
      expect(app).toBeNull();
    });

    it('should reject deletion from other developers', async () => {
      const created = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await expect(
        appsService.deleteApp(created.id, 'other-developer-id')
      ).rejects.toThrow('App not found or access denied');
    });
  });

  describe('listApps', () => {
    beforeEach(async () => {
      await appsService.createApp(developerId, {
        appId: 'com.example.app1',
        name: 'App One',
        category: 'utilities',
      });
      await appsService.createApp(developerId, {
        appId: 'com.example.app2',
        name: 'App Two',
        category: 'finance',
      });
      await appsService.createApp(developerId, {
        appId: 'com.example.app3',
        name: 'App Three',
        category: 'utilities',
      });
    });

    it('should list all apps for developer', async () => {
      const result = await appsService.listApps({ developerId });

      expect(result.apps.length).toBe(3);
      expect(result.total).toBe(3);
    });

    it('should filter by category', async () => {
      const result = await appsService.listApps({
        developerId,
        category: 'utilities',
      });

      expect(result.apps.length).toBe(2);
    });

    it('should search by name', async () => {
      const result = await appsService.listApps({
        developerId,
        search: 'Two',
      });

      expect(result.apps.length).toBe(1);
      expect(result.apps[0].name).toBe('App Two');
    });

    it('should paginate results', async () => {
      const result = await appsService.listApps({
        developerId,
        limit: 2,
        offset: 0,
      });

      expect(result.apps.length).toBe(2);
      expect(result.total).toBe(3);
    });
  });

  describe('App Status Workflow', () => {
    it('should start in draft status', async () => {
      const app = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      expect(app.status).toBe('draft');
    });

    it('should reject submission without ready versions', async () => {
      const app = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await expect(
        appsService.submitForReview(app.id, developerId)
      ).rejects.toThrow('must have at least one ready version');
    });

    it('should reject publishing unapproved apps', async () => {
      const app = await appsService.createApp(developerId, {
        appId: 'com.example.testapp',
        name: 'Test App',
      });

      await expect(
        appsService.publishApp(app.id, developerId)
      ).rejects.toThrow('Only approved apps can be published');
    });
  });
});
