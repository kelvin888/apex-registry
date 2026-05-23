/**
 * Server Integration Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServer } from '../server';
import { closeDatabase } from '../db';
import { type Config } from '../config';
import { FastifyInstance } from 'fastify';

describe('Server Integration', () => {
  let tempDir: string;
  let config: Config;
  let server: FastifyInstance;

  beforeAll(async () => {
    // Create temp directories for package storage
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-server-test-'));
    const storagePath = path.join(tempDir, 'packages');
    const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/apex_test';

    config = {
      host: '127.0.0.1',
      port: 0, // Random port
      nodeEnv: 'test',
      databaseUrl,
      jwtSecret: 'test-secret-key-for-testing-only!',
      jwtExpiresIn: '7d',
      storagePath,
      maxPackageSize: 50 * 1024 * 1024,
      rateLimit: 1000,
      rateLimitWindow: 60000,
      corsOrigins: ['*'],
      logLevel: 'error',
    };

    server = await createServer({ config, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('Auth Endpoints', () => {
    it('should register a new developer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Developer',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.developer).toBeDefined();
      expect(body.apiKey).toBeDefined();
      expect(body.token).toBeDefined();
    });

    it('should login with valid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.developer).toBeDefined();
      expect(body.token).toBeDefined();
    });

    it('should reject invalid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return current user with valid token', async () => {
      // Login first
      const loginResponse = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const { token } = JSON.parse(loginResponse.body);

      // Get current user
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.email).toBe('test@example.com');
    });

    it('should reject requests without token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Apps Endpoints', () => {
    let token: string;

    beforeEach(async () => {
      const loginResponse = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      token = JSON.parse(loginResponse.body).token;
    });

    it('should create a new app', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/apps',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          appId: 'com.example.newapp',
          name: 'New App',
          description: 'A new test app',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.appId).toBe('com.example.newapp');
      expect(body.name).toBe('New App');
    });

    it('should list apps', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/apps',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.apps).toBeDefined();
      expect(Array.isArray(body.apps)).toBe(true);
    });

    it('should reject invalid appId format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/apps',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          appId: 'invalid',
          name: 'Test',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Registry Endpoints', () => {
    it('should search public apps', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/registry/search',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.apps).toBeDefined();
      expect(body.total).toBeDefined();
    });

    it('should return categories', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/registry/categories',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.categories).toBeDefined();
      expect(Array.isArray(body.categories)).toBe(true);
      expect(body.categories.length).toBeGreaterThan(0);
    });

    it('should return 404 for non-existent app', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/registry/apps/com.nonexistent.app',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Swagger Documentation', () => {
    it('should serve swagger UI', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs',
      });

      // Should redirect to /docs/
      expect(response.statusCode).toBe(302);
    });

    it('should serve OpenAPI spec', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs/json',
      });

      expect(response.statusCode).toBe(200);
      const spec = JSON.parse(response.body);
      expect(spec.openapi).toBeDefined();
      expect(spec.info.title).toBe('APEX Distribution Server');
    });
  });
});
