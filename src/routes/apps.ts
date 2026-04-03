/**
 * Apps Routes
 *
 * Mini-app management endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as appsService from '../services/apps';
import * as versionsService from '../services/versions';

const createAppSchema = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/),
  name: z.string().min(2).max(50),
  description: z.string().max(500).optional(),
  icon: z.string().url().optional(),
  category: z.string().optional(),
  supportedCountries: z.array(z.string().length(2).toUpperCase()).optional(),
});

const updateAppSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().url().optional(),
  category: z.string().optional(),
  supportedCountries: z.array(z.string().length(2).toUpperCase()).optional(),
});

const listAppsSchema = z.object({
  status: z.enum(['draft', 'pending', 'approved', 'rejected', 'suspended']).optional(),
  category: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export const appsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * List my apps
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'List apps owned by current developer',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'pending', 'approved', 'rejected', 'suspended'] },
          search: { type: 'string' },
          limit: { type: 'number', default: 20 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const query = listAppsSchema.parse(request.query);

    const result = await appsService.listApps({
      developerId: request.user.id,
      ...query,
    });

    return {
      apps: result.apps.map(app => ({
        ...app,
        latestVersion: app.latestVersion?.version,
      })),
      total: result.total,
    };
  });

  /**
   * Create app
   */
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Register a new mini-app',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['appId', 'name'],
        properties: {
          appId: { type: 'string', pattern: String.raw`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` },
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          icon: { type: 'string', format: 'uri' },
          category: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const input = createAppSchema.parse(request.body);

    try {
      const app = await appsService.createApp(request.user.id, input);
      reply.code(201);
      return app;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Get app by ID
   */
  fastify.get('/:appId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Get app details',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const app = await appsService.getAppByAppId(appId);
    if (!app) {
      reply.code(404);
      throw new Error('App not found');
    }

    // Check access
    if (app.developerId !== request.user.id && request.user.role !== 'admin') {
      if (!app.isPublic) {
        reply.code(403);
        throw new Error('Access denied');
      }
    }

    // Get versions with per-version download counts
    const versionList = await versionsService.listVersions(app.id);

    // Compute total downloads across all versions
    const totalDownloads = versionList.reduce((sum, v) => sum + v.downloadCount, 0);

    return {
      ...app,
      stats: {
        downloads: totalDownloads,
        activeUsers: 0,
        rating: 0,
        reviews: 0,
      },
      versions: versionList.map(v => ({
        id: v.id,
        version: v.version,
        status: v.status,
        downloads: v.downloadCount,
        createdAt: v.createdAt,
      })),
    };
  });

  /**
   * Update app
   */
  fastify.patch('/:appId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Update app metadata',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          icon: { type: 'string', format: 'uri' },
          category: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const input = updateAppSchema.parse(request.body);

    const appRecord = await appsService.getAppByAppId(appId);
    if (!appRecord) {
      reply.code(404);
      throw new Error('App not found');
    }

    try {
      const app = await appsService.updateApp(appRecord.id, request.user.id, input);
      return app;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Delete app
   */
  fastify.delete('/:appId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Delete an app',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const appRecord = await appsService.getAppByAppId(appId);
    if (!appRecord) {
      reply.code(404);
      throw new Error('App not found');
    }

    try {
      await appsService.deleteApp(appRecord.id, request.user.id);
      return { success: true };
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Submit for review
   */
  fastify.post('/:appId/submit', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Submit app for review',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const appRecord = await appsService.getAppByAppId(appId);
    if (!appRecord) {
      reply.code(404);
      throw new Error('App not found');
    }

    try {
      const app = await appsService.submitForReview(appRecord.id, request.user.id);
      return app;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Publish app
   */
  fastify.post('/:appId/publish', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Make app publicly available',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const appRecord = await appsService.getAppByAppId(appId);
    if (!appRecord) {
      reply.code(404);
      throw new Error('App not found');
    }

    try {
      const app = await appsService.publishApp(appRecord.id, request.user.id);
      return app;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Unpublish app
   */
  fastify.post('/:appId/unpublish', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Remove app from public listing',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const appRecord = await appsService.getAppByAppId(appId);
    if (!appRecord) {
      reply.code(404);
      throw new Error('App not found');
    }

    try {
      const app = await appsService.unpublishApp(appRecord.id, request.user.id);
      return app;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Get download stats
   */
  fastify.get('/:appId/stats', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Get app download statistics',
      tags: ['apps'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'number', default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const { days = 30 } = request.query as { days?: number };

    const app = await appsService.getAppByAppId(appId);
    if (!app || app.developerId !== request.user.id) {
      reply.code(404);
      throw new Error('App not found');
    }

    const stats = await versionsService.getDownloadStats(app.id, days);
    return { stats };
  });
};
