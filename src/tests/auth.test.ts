/**
 * Auth Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initDatabase, closeDatabase, runMigrations } from '../db';
import * as authService from '../services/auth';

describe('Auth Service', () => {
  let dbPath: string;

  beforeEach(() => {
    // Create temp database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-server-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDatabase({ path: dbPath });
    runMigrations();
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  describe('registerDeveloper', () => {
    it('should register a new developer', async () => {
      const result = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
        organization: 'Test Org',
      });

      expect(result.developer).toBeDefined();
      expect(result.developer.email).toBe('test@example.com');
      expect(result.developer.name).toBe('Test Developer');
      expect(result.developer.organization).toBe('Test Org');
      expect(result.developer.role).toBe('developer');
      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).toMatch(/^apex_/);
    });

    it('should reject duplicate emails', async () => {
      await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });

      await expect(
        authService.registerDeveloper({
          email: 'test@example.com',
          password: 'password456',
          name: 'Another Developer',
        })
      ).rejects.toThrow('Email already registered');
    });

    it('should hash the password', async () => {
      const result = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });

      // Password hash should not be exposed
      expect((result.developer as any).passwordHash).toBeUndefined();
    });
  });

  describe('loginDeveloper', () => {
    beforeEach(async () => {
      await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });
    });

    it('should login with valid credentials', async () => {
      const result = await authService.loginDeveloper({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.developer).toBeDefined();
      expect(result.developer.email).toBe('test@example.com');
    });

    it('should reject invalid password', async () => {
      await expect(
        authService.loginDeveloper({
          email: 'test@example.com',
          password: 'wrongpassword',
        })
      ).rejects.toThrow('Invalid credentials');
    });

    it('should reject unknown email', async () => {
      await expect(
        authService.loginDeveloper({
          email: 'unknown@example.com',
          password: 'password123',
        })
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('verifyApiKey', () => {
    let apiKey: string;

    beforeEach(async () => {
      const result = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });
      apiKey = result.apiKey!;
    });

    it('should verify valid API key', async () => {
      const developer = await authService.verifyApiKey(apiKey);

      expect(developer).not.toBeNull();
      expect(developer!.email).toBe('test@example.com');
    });

    it('should reject invalid API key', async () => {
      const developer = await authService.verifyApiKey('apex_invalidkey12345678901234567890');

      expect(developer).toBeNull();
    });
  });

  describe('getDeveloperById', () => {
    it('should return developer by ID', async () => {
      const { developer: created } = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });

      const developer = await authService.getDeveloperById(created.id);

      expect(developer).not.toBeNull();
      expect(developer!.email).toBe('test@example.com');
    });

    it('should return null for unknown ID', async () => {
      const developer = await authService.getDeveloperById('unknown-id');
      expect(developer).toBeNull();
    });
  });

  describe('changePassword', () => {
    let developerId: string;

    beforeEach(async () => {
      const { developer } = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });
      developerId = developer.id;
    });

    it('should change password with valid current password', async () => {
      await authService.changePassword(developerId, 'password123', 'newpassword456');

      // Should be able to login with new password
      const result = await authService.loginDeveloper({
        email: 'test@example.com',
        password: 'newpassword456',
      });
      expect(result.developer).toBeDefined();
    });

    it('should reject with wrong current password', async () => {
      await expect(
        authService.changePassword(developerId, 'wrongpassword', 'newpassword456')
      ).rejects.toThrow('Current password is incorrect');
    });
  });

  describe('API Keys', () => {
    let developerId: string;

    beforeEach(async () => {
      const { developer } = await authService.registerDeveloper({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test Developer',
      });
      developerId = developer.id;
    });

    it('should create additional API key', async () => {
      const key = await authService.createApiKey(developerId, 'CI Key', ['upload', 'publish']);

      expect(key).toMatch(/^apex_/);

      // Should be verifiable
      const developer = await authService.verifyApiKey(key);
      expect(developer).not.toBeNull();
    });

    it('should list API keys', async () => {
      await authService.createApiKey(developerId, 'CI Key', ['upload']);
      await authService.createApiKey(developerId, 'Prod Key', ['read']);

      const keys = await authService.listApiKeys(developerId);

      expect(keys.length).toBe(2);
      expect(keys[0].name).toBeDefined();
      expect(keys[0].keyPrefix).toBeDefined();
    });

    it('should revoke API key', async () => {
      const key = await authService.createApiKey(developerId, 'CI Key', ['upload']);
      const keys = await authService.listApiKeys(developerId);

      const success = await authService.revokeApiKey(developerId, keys[0].id);
      expect(success).toBe(true);

      // Key should no longer work
      const developer = await authService.verifyApiKey(key);
      expect(developer).toBeNull();
    });
  });
});
