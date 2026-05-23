/**
 * Registry Routes
 *
 * Public endpoints for host apps to discover and download mini-apps
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import * as appsService from '../services/apps';
import * as versionsService from '../services/versions';
import { getStoragePath, type Config } from '../config';

/**
 * Resolve a stored icon value to a full URL.
 * - `local:icon.png`  → `{baseUrl}/api/registry/apps/{appId}/icon`
 * - `https://...`     → pass-through
 * - null/undefined    → null
 */
function resolveIconUrl(icon: string | null | undefined, appId: string, baseUrl: string): string | null {
  if (!icon) return null;
  if (icon.startsWith('local:')) {
    return `${baseUrl}/api/registry/apps/${appId}/icon`;
  }
  return icon;
}

const searchSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  platform: z.enum(['mobile', 'web', 'universal']).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export const registryRoutes: FastifyPluginAsync<{ config: Config }> = async (fastify, opts) => {
  const config = opts.config;

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
          platform: { type: 'string', enum: ['mobile', 'web', 'universal'], description: 'Filter by platform' },
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
      platform: query.platform,
      limit: query.limit,
      offset: query.offset,
      publicOnly: true,
    });

    const proto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || request.protocol;
    const baseUrl = `${proto}://${request.hostname}`;

    // Return only public info
    return {
      apps: result.apps.map(app => ({
        appId: app.appId,
        name: app.name,
        description: app.description,
        icon: resolveIconUrl(app.icon, app.appId, baseUrl),
        category: app.category,
        platform: app.platform,
        supportedCountries: app.supportedCountries ? JSON.parse(app.supportedCountries) : [],
        latestVersion: app.latestVersion ? {
          version: app.latestVersion.version,
          versionCode: app.latestVersion.versionCode,
          changelog: app.latestVersion.changelog,
          downloadUrl: `${baseUrl}/api/registry/apps/${app.appId}/download`,
          packageSize: app.latestVersion.packageSize,
        } : null,
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

    const proto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || request.protocol;
    const baseUrl = `${proto}://${request.hostname}`;

    return {
      appId: app.appId,
      name: app.name,
      description: app.description,
      icon: resolveIconUrl(app.icon, app.appId, baseUrl),
      category: app.category,
      platform: app.platform,
      supportedCountries: app.supportedCountries ? JSON.parse(app.supportedCountries) : [],
      latestVersion: latestVersion ? {
        version: latestVersion.version,
        versionCode: latestVersion.versionCode,
        changelog: latestVersion.changelog,
        minHostVersion: latestVersion.minHostVersion,
        permissions: latestVersion.permissions ? JSON.parse(latestVersion.permissions) : [],
        packageSize: latestVersion.packageSize,
        packageHash: latestVersion.packageHash,
        publishedAt: latestVersion.publishedAt,
        downloadUrl: `${baseUrl}/api/registry/apps/${app.appId}/download`,
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
   * Serve individual file from app package (Re.Pack-style lazy loading).
   * Host apps fetch manifest.json, app.js, page JS etc. directly — no ZIP download,
   * no local install. Each launch gets the freshest content from the server.
   */
  fastify.get('/apps/:appId/files/*', {
    schema: {
      description: 'Serve a single file from the latest app package',
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
    const rawFilepath = (request.params as Record<string, string>)['*'];

    // Security: reject empty, absolute, or path-traversal attempts
    if (!rawFilepath) {
      reply.code(400);
      throw new Error('File path required');
    }
    const normalizedPath = path.posix.normalize(rawFilepath);
    if (
      path.posix.isAbsolute(normalizedPath) ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../') ||
      normalizedPath.includes('\0')
    ) {
      reply.code(400);
      throw new Error('Invalid file path');
    }

    const app = await appsService.getAppByAppId(appId);
    if (!app || !app.isPublic || app.status !== 'approved') {
      reply.code(404);
      throw new Error('App not found');
    }

    const version = await versionsService.getLatestVersion(app.id);
    if (!version || !version.packagePath) {
      reply.code(404);
      throw new Error('Version not found');
    }

    if (!fs.existsSync(version.packagePath)) {
      reply.code(500);
      throw new Error('Package file not found on server');
    }

    const zip = new AdmZip(version.packagePath);
    const entry = zip.getEntry(normalizedPath);

    if (!entry || entry.isDirectory) {
      reply.code(404);
      throw new Error(`File not found in package: ${normalizedPath}`);
    }

    const contentType = mime.lookup(normalizedPath) || 'application/octet-stream';

    reply
      .header('Content-Type', contentType)
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', 'no-store, no-cache');

    return reply.send(entry.getData());
  });

  /**
   * Serve app icon from local storage.
   * Only responds for apps whose icon was bundled in the .map package
   * (stored as `local:{filename}` in the DB).
   */
  fastify.get('/apps/:appId/icon', {
    schema: {
      description: 'Get app icon image',
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
    if (!app) {
      reply.code(404);
      throw new Error('App not found');
    }

    if (!app.icon?.startsWith('local:')) {
      reply.code(404);
      throw new Error('No bundled icon');
    }

    const iconFilename = app.icon.slice('local:'.length);
    // Sanitize: only allow simple filenames like "icon.png"
    if (iconFilename.includes('/') || iconFilename.includes('\\') || iconFilename.includes('..')) {
      reply.code(400);
      throw new Error('Invalid icon reference');
    }

    const iconPath = path.join(getStoragePath(config, app.appId), iconFilename);
    if (!fs.existsSync(iconPath)) {
      reply.code(404);
      throw new Error('Icon file not found');
    }

    const contentType = mime.lookup(iconFilename) || 'image/png';
    const stream = fs.createReadStream(iconPath);

    reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=86400')
      .header('Access-Control-Allow-Origin', '*');

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
