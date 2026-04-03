/**
 * Preview Routes
 *
 * Endpoints for the CLI `apex preview --upload` workflow.
 *
 *   POST /api/preview/upload          — authenticated; accepts .map file + token
 *   GET  /api/preview/:token          — returns preview metadata (no auth)
 *   GET  /api/preview/:token/download — streams the .map package (no auth)
 */

import { FastifyPluginAsync } from 'fastify';
import { type Config } from '../config';
import * as previewService from '../services/preview';
import * as fs from 'node:fs';

export const previewRoutes: FastifyPluginAsync<{ config: Config }> = async (fastify, opts) => {
  const { config } = opts;

  /**
   * POST /api/preview/upload
   *
   * Multipart fields:
   *   file   — the .map binary (required)
   *   token  — preview token from CLI (required)
   *   appId  — reverse-domain app ID (optional; derived from token if absent)
   */
  fastify.post('/upload', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Upload a preview package for device testing',
      tags: ['preview'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
  }, async (request, reply) => {
    const parts = request.parts();
    let fileBuf: Buffer | null = null;
    let token: string | null = null;
    let appId: string | null = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuf = await part.toBuffer();
      } else {
        const value = (part as { value: string }).value;
        if (part.fieldname === 'token') token = value;
        if (part.fieldname === 'appId') appId = value;
      }
    }

    if (!fileBuf) {
      reply.code(400).send({ error: 'No file uploaded', statusCode: 400 });
      return;
    }
    if (!token) {
      reply.code(400).send({ error: 'Missing token field', statusCode: 400 });
      return;
    }
    if (!appId) {
      const tokenParts = token.split('-');
      appId = tokenParts.length > 3 ? tokenParts.slice(0, -3).join('.') : token;
    }

    previewService.purgeExpiredPreviews().catch(() => { /* ignore */ });

    const record = await previewService.storePreview(
      token,
      appId,
      fileBuf,
      config.storagePath,
      request.user.id,
    );

    const scheme = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = request.headers.host ?? `localhost:${config.port}`;
    const baseUrl = `${scheme}://${host}`;
    const previewUrl = `${baseUrl}/api/preview/${encodeURIComponent(token)}`;

    reply.code(201);
    return {
      previewUrl,
      downloadUrl: `${previewUrl}/download`,
      token,
      appId,
      expiresAt: record.expiresAt.toISOString(),
    };
  });

  /**
   * GET /api/preview/:token
   * Returns metadata. No auth required.
   */
  fastify.get('/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await previewService.getPreview(token);
    if (!record) {
      reply.code(404).send({ error: 'Preview not found or expired', statusCode: 404 });
      return;
    }

    const scheme = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = request.headers.host ?? `localhost:${config.port}`;
    const baseUrl = `${scheme}://${host}`;

    return {
      token: record.token,
      appId: record.appId,
      expiresAt: record.expiresAt.toISOString(),
      downloadUrl: `${baseUrl}/api/preview/${encodeURIComponent(token)}/download`,
    };
  });

  /**
   * GET /api/preview/:token/download
   * Streams the .map binary. No auth required.
   */
  fastify.get('/:token/download', async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await previewService.getPreview(token);
    if (!record) {
      reply.code(404).send({ error: 'Preview not found or expired', statusCode: 404 });
      return;
    }

    if (!fs.existsSync(record.packagePath)) {
      reply.code(404).send({ error: 'Package file missing', statusCode: 404 });
      return;
    }

    const stat = fs.statSync(record.packagePath);
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(token)}.map"`)
      .header('Content-Length', String(stat.size));

    return reply.send(fs.createReadStream(record.packagePath));
  });
};
