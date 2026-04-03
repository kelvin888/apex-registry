/**
 * History Routes
 *
 * Cross-vertical transaction history: query receipts, get receipt detail.
 * All endpoints require user JWT (scope: 'user').
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as historyService from '../services/history';

export const historyRoutes: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // USER AUTH DECORATOR
  // =========================================================================

  const authenticateUser = async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      const payload = request.user as { sub?: string; scope?: string };
      if (payload.scope !== 'user' || !payload.sub) {
        reply.code(401).send({ error: 'Invalid user token' });
        return;
      }
      request.userId = payload.sub;
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // =========================================================================
  // QUERY RECEIPTS
  // =========================================================================

  fastify.get('/receipts', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Query cross-vertical transaction history',
      tags: ['history'],
      querystring: {
        type: 'object',
        properties: {
          vertical: { type: 'string', maxLength: 50 },
          type: { type: 'string', maxLength: 50 },
          status: { type: 'string', enum: ['completed', 'pending', 'failed', 'refunded'] },
          startDate: { type: 'integer' },
          endDate: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        vertical: z.string().max(50).optional(),
        type: z.string().max(50).optional(),
        status: z.enum(['completed', 'pending', 'failed', 'refunded']).optional(),
        startDate: z.coerce.number().optional(),
        endDate: z.coerce.number().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);

    return historyService.queryReceipts(request.userId!, params);
  });

  // =========================================================================
  // GET RECEIPT DETAIL
  // =========================================================================

  fastify.get('/receipt/:receiptId', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get receipt detail by ID',
      tags: ['history'],
      params: {
        type: 'object',
        required: ['receiptId'],
        properties: {
          receiptId: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { receiptId } = z
      .object({ receiptId: z.string().min(1) })
      .parse(request.params);

    return historyService.getReceipt(request.userId!, receiptId);
  });
};
