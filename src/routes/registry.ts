/**
 * Registry Routes
 *
 * Public endpoints for host apps to discover and download mini-apps
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as appsService from '../services/apps';
import * as versionsService from '../services/versions';

const searchSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export const registryRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Search public apps
   */
  fastify.get('/search', {
    schema: {
      description: 'Search for public mini-apps',
      tags: ['registry'],
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query' },
          category: { type: 'string', description: 'Filter by category' },
          limit: { type: 'number', default: 20 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const query = searchSchema.parse(request.query);

    const result = await appsService.listApps({
      search: query.q,
      category: query.category,
      limit: query.limit,
      offset: query.offset,
      publicOnly: true,
    });

    // Return only public info
    return {
      apps: result.apps.map(app => ({
        appId: app.appId,
        name: app.name,
        description: app.description,
        icon: app.icon,
        category: app.category,
        latestVersion: app.latestVersion,
        downloads: app.totalDownloads,
      })),
      total: result.total,
    };
  });

  /**
   * Get app info
   */
  fastify.get('/apps/:appId', {
    schema: {
      description: 'Get public app information',
      tags: ['registry'],
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
    if (!app || !app.isPublic || app.status !== 'approved') {
      reply.code(404);
      throw new Error('App not found');
    }

    const latestVersion = await versionsService.getLatestVersion(app.id);

    return {
      appId: app.appId,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      latestVersion: latestVersion ? {
        version: latestVersion.version,
        versionCode: latestVersion.versionCode,
        changelog: latestVersion.changelog,
        minHostVersion: latestVersion.minHostVersion,
        permissions: latestVersion.permissions ? JSON.parse(latestVersion.permissions) : [],
        packageSize: latestVersion.packageSize,
        packageHash: latestVersion.packageHash,
        publishedAt: latestVersion.publishedAt,
      } : null,
    };
  });

  /**
   * Get app manifest (for update checks)
   */
  fastify.get('/apps/:appId/manifest', {
    schema: {
      description: 'Get app manifest for update checking',
      tags: ['registry'],
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
    if (!app || !app.isPublic || app.status !== 'approved') {
      reply.code(404);
      throw new Error('App not found');
    }

    const versions = await versionsService.listVersions(app.id);
    const readyVersions = versions.filter(v => v.status === 'ready');

    return {
      appId: app.appId,
      name: app.name,
      versions: readyVersions.map(v => ({
        version: v.version,
        versionCode: v.versionCode,
        minHostVersion: v.minHostVersion,
        packageSize: v.packageSize,
        packageHash: v.packageHash,
      })),
    };
  });

  /**
   * Download package
   */
  fastify.get('/apps/:appId/download', {
    schema: {
      description: 'Download app package',
      tags: ['registry'],
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
          version: { type: 'string', description: 'Specific version to download' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          'x-host-app-id': { type: 'string' },
          'x-host-version': { type: 'string' },
          'x-platform': { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const { version: requestedVersion } = request.query as { version?: string };

    const app = await appsService.getAppByAppId(appId);
    if (!app || !app.isPublic || app.status !== 'approved') {
      reply.code(404);
      throw new Error('App not found');
    }

    let version;
    if (requestedVersion) {
      const versions = await versionsService.listVersions(app.id);
      version = versions.find(v => v.version === requestedVersion && v.status === 'ready');
    } else {
      version = await versionsService.getLatestVersion(app.id);
    }

    if (!version || !version.packagePath) {
      reply.code(404);
      throw new Error('Version not found');
    }

    if (!fs.existsSync(version.packagePath)) {
      reply.code(500);
      throw new Error('Package file not found');
    }

    // Record download
    const headers = request.headers as Record<string, string>;
    const ipHash = crypto.createHash('sha256')
      .update(request.ip || 'unknown')
      .digest('hex')
      .slice(0, 16);

    await versionsService.recordDownload(version.id, {
      hostAppId: headers['x-host-app-id'],
      hostVersion: headers['x-host-version'],
      platform: headers['x-platform'],
      region: headers['cf-ipcountry'] || headers['x-country'],
      ipHash,
    });

    // Send file
    const stream = fs.createReadStream(version.packagePath);

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${app.appId}-${version.version}.map"`)
      .header('Content-Length', version.packageSize)
      .header('X-Package-Hash', version.packageHash)
      .header('X-Package-Version', version.version)
      .header('X-Package-Signature', version.signature || '');

    return reply.send(stream);
  });

  /**
   * Verify package signature
   */
  fastify.post('/verify', {
    schema: {
      description: 'Verify package signature',
      tags: ['registry'],
      body: {
        type: 'object',
        required: ['appId', 'hash', 'signature'],
        properties: {
          appId: { type: 'string' },
          hash: { type: 'string' },
          signature: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId, hash, signature } = request.body as {
      appId: string;
      hash: string;
      signature: string;
    };

    const app = await appsService.getAppByAppId(appId);
    if (!app) {
      reply.code(404);
      throw new Error('App not found');
    }

    const versions = await versionsService.listVersions(app.id);
    const version = versions.find(v => v.packageHash === hash);

    if (!version) {
      return { valid: false, reason: 'Unknown package hash' };
    }

    if (!version.signature) {
      return { valid: false, reason: 'Package not signed' };
    }

    if (version.signature !== signature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    return {
      valid: true,
      appId: app.appId,
      version: version.version,
      versionCode: version.versionCode,
    };
  });

  /**
   * Get categories
   */
  fastify.get('/categories', {
    schema: {
      description: 'Get available app categories',
      tags: ['registry'],
    },
  }, async () => {
    return {
      categories: [
        { id: 'finance', name: 'Finance & Banking', icon: '💰' },
        { id: 'shopping', name: 'Shopping', icon: '🛒' },
        { id: 'food', name: 'Food & Delivery', icon: '🍔' },
        { id: 'travel', name: 'Travel & Transport', icon: '✈️' },
        { id: 'entertainment', name: 'Entertainment', icon: '🎬' },
        { id: 'utilities', name: 'Utilities', icon: '🔧' },
        { id: 'health', name: 'Health & Fitness', icon: '💪' },
        { id: 'education', name: 'Education', icon: '📚' },
        { id: 'business', name: 'Business', icon: '💼' },
        { id: 'social', name: 'Social', icon: '👥' },
        { id: 'games', name: 'Games', icon: '🎮' },
        { id: 'other', name: 'Other', icon: '📦' },
      ],
    };
  });
};
