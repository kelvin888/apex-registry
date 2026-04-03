/**
 * Bill Payment Routes
 *
 * Biller catalog, customer validation, bill payment, saved billers,
 * and scheduled payments.
 * All mutation endpoints require user JWT (scope: 'user').
 * Catalog endpoints (categories, billers) are public.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as billsService from '../services/bills';

export const billsRoutes: FastifyPluginAsync = async (fastify) => {
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
  // CATALOG — PUBLIC
  // =========================================================================

  fastify.get('/categories', {
    schema: {
      description: 'List biller categories',
      tags: ['bills'],
      querystring: {
        type: 'object',
        properties: {
          country: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { country } = request.query as { country?: string };
      const categories = billsService.getCategories(country);
      reply.send({ categories });
    },
  });

  fastify.get('/billers', {
    schema: {
      description: 'List billers, optionally filtered by category or search',
      tags: ['bills'],
      querystring: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          country: { type: 'string' },
          search: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const query = request.query as { category?: string; country?: string; search?: string };
      const billersList = billsService.getBillers(query);
      reply.send({ billers: billersList });
    },
  });

  fastify.get('/billers/:billerId', {
    schema: {
      description: 'Get biller details',
      tags: ['bills'],
      params: {
        type: 'object',
        required: ['billerId'],
        properties: { billerId: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const { billerId } = request.params as { billerId: string };
      const biller = billsService.getBiller(billerId);
      if (!biller) return reply.code(404).send({ error: 'Biller not found' });
      reply.send(biller);
    },
  });

  // =========================================================================
  // VALIDATE CUSTOMER
  // =========================================================================

  const validateSchema = z.object({
    billerId: z.string().min(1),
    customerId: z.string().min(1),
  });

  fastify.post('/validate', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Validate a customer identifier for a biller',
      tags: ['bills'],
    },
    handler: async (request, reply) => {
      const parsed = validateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const result = billsService.validateCustomer(parsed.data.billerId, parsed.data.customerId);
      reply.send(result);
    },
  });

  // =========================================================================
  // PAY BILL
  // =========================================================================

  const paySchema = z.object({
    billerId: z.string().min(1),
    customerId: z.string().min(1),
    amount: z.number().int().positive(),
    currency: z.string().length(3).optional(),
    saveAsBiller: z.boolean().optional(),
    alias: z.string().max(50).optional(),
  });

  fastify.post('/pay', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Pay a bill — debits wallet, generates receipt',
      tags: ['bills'],
    },
    handler: async (request, reply) => {
      const parsed = paySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const result = billsService.payBill((request as any).userId, parsed.data);
        reply.send(result);
      } catch (err: any) {
        reply.code(err.statusCode || 500).send({ error: err.message || 'Payment failed' });
      }
    },
  });

  // =========================================================================
  // SAVED BILLERS
  // =========================================================================

  fastify.get('/saved', {
    onRequest: [authenticateUser],
    schema: { description: 'List saved billers', tags: ['bills'] },
    handler: async (request, reply) => {
      const rows = billsService.getSavedBillers((request as any).userId);
      reply.send({ savedBillers: rows });
    },
  });

  const saveBillerSchema = z.object({
    billerId: z.string().min(1),
    customerId: z.string().min(1),
    alias: z.string().max(50).optional(),
  });

  fastify.post('/saved', {
    onRequest: [authenticateUser],
    schema: { description: 'Save a biller for quick reuse', tags: ['bills'] },
    handler: async (request, reply) => {
      const parsed = saveBillerSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const result = billsService.saveBiller((request as any).userId, parsed.data);
        reply.send(result);
      } catch (err: any) {
        reply.code(err.statusCode || 500).send({ error: err.message });
      }
    },
  });

  fastify.delete('/saved/:id', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Delete a saved biller',
      tags: ['bills'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = billsService.deleteSavedBiller((request as any).userId, id);
      reply.send(result);
    },
  });

  // =========================================================================
  // SCHEDULED PAYMENTS
  // =========================================================================

  fastify.get('/scheduled', {
    onRequest: [authenticateUser],
    schema: { description: 'List active scheduled payments', tags: ['bills'] },
    handler: async (request, reply) => {
      const rows = billsService.getScheduledPayments((request as any).userId);
      reply.send({ scheduledPayments: rows });
    },
  });

  const scheduleSchema = z.object({
    billerId: z.string().min(1),
    customerId: z.string().min(1),
    amount: z.number().int().positive(),
    currency: z.string().length(3).optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
  });

  fastify.post('/scheduled', {
    onRequest: [authenticateUser],
    schema: { description: 'Create a scheduled/recurring payment', tags: ['bills'] },
    handler: async (request, reply) => {
      const parsed = scheduleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const result = billsService.schedulePayment((request as any).userId, parsed.data);
        reply.send(result);
      } catch (err: any) {
        reply.code(err.statusCode || 500).send({ error: err.message });
      }
    },
  });

  fastify.delete('/scheduled/:id', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Cancel a scheduled payment',
      tags: ['bills'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = billsService.cancelScheduledPayment((request as any).userId, id);
      reply.send(result);
    },
  });
};
