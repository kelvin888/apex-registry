/**
 * Versions Routes
 *
 * App version management endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as versionsService from '../services/versions';
import * as appsService from '../services/apps';
import { loadConfig } from '../config';

const createVersionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),
  changelog: z.string().max(2000).optional(),
  minHostVersion: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

export const versionsRoutes: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();

  /**
   * Create version
   */
  fastify.post('/:appId/versions', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Create a new version for an app',
      tags: ['versions'],
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
        required: ['version'],
        properties: {
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(-[a-zA-Z0-9.]+)?$' },
          changelog: { type: 'string', maxLength: 2000 },
          minHostVersion: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const input = createVersionSchema.parse(request.body);

    try {
      const version = await versionsService.createVersion(appId, request.user.id, input);
      reply.code(201);
      return version;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Upload package
   */
  fastify.post('/:appId/versions/:versionId/upload', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Upload package file for a version',
      tags: ['versions'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      params: {
        type: 'object',
        required: ['appId', 'versionId'],
        properties: {
          appId: { type: 'string' },
          versionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { versionId } = request.params as { appId: string; versionId: string };

    const data = await request.file();
    if (!data) {
      reply.code(400);
      throw new Error('No file uploaded');
    }

    const buffer = await data.toBuffer();

    try {
      const version = await versionsService.uploadPackage(
        versionId,
        request.user.id,
        {
          buffer,
          filename: data.filename,
        },
        config
      );

      return version;
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Get version
   */
  fastify.get('/:appId/versions/:versionId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Get version details',
      tags: ['versions'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId', 'versionId'],
        properties: {
          appId: { type: 'string' },
          versionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId, versionId } = request.params as { appId: string; versionId: string };

    const version = await versionsService.getVersionById(versionId);
    if (!version || version.appId !== appId) {
      reply.code(404);
      throw new Error('Version not found');
    }

    return version;
  });

  /**
   * List versions
   */
  fastify.get('/:appId/versions', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'List all versions for an app',
      tags: ['versions'],
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

    const app = await appsService.getAppById(appId);
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

    const versions = await versionsService.listVersions(appId);
    return { versions };
  });

  /**
   * Delete version
   */
  fastify.delete('/:appId/versions/:versionId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Delete a version',
      tags: ['versions'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['appId', 'versionId'],
        properties: {
          appId: { type: 'string' },
          versionId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { versionId } = request.params as { appId: string; versionId: string };

    try {
      await versionsService.deleteVersion(versionId, request.user.id, config);
      return { success: true };
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });
};
