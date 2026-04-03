/**
 * Savings Routes
 *
 * Personal savings goals (create, deposit, withdraw, cancel),
 * Ajo/Esusu group management (create, join, contribute).
 * All endpoints require user JWT.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as savingsService from '../services/savings';

export const savingsRoutes: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // AUTH DECORATOR
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
  // SAVINGS GOALS
  // =========================================================================

  fastify.get('/goals', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get all savings goals',
      tags: ['savings'],
    },
  }, async (request) => {
    return { goals: savingsService.getGoals((request as any).userId) };
  });

  fastify.post('/goals', {
    preHandler: authenticateUser,
    schema: {
      description: 'Create a new savings goal',
      tags: ['savings'],
      body: z.object({
        name: z.string().min(1).max(100),
        targetAmount: z.number().int().positive(),
        currency: z.string().default('NGN'),
        deadline: z.number().int().optional(),
        locked: z.boolean().default(false),
        autoDeductFrequency: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
        autoDeductAmount: z.number().int().positive().optional(),
      }),
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const result = await savingsService.createGoal((request as any).userId, body);
    return reply.code(201).send(result);
  });

  fastify.get('/goals/:goalId', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get savings goal detail with transactions',
      tags: ['savings'],
      params: z.object({ goalId: z.string() }),
    },
  }, async (request, reply) => {
    try {
      const { goalId } = request.params as { goalId: string };
      return savingsService.getGoal((request as any).userId, goalId);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.post('/goals/:goalId/deposit', {
    preHandler: authenticateUser,
    schema: {
      description: 'Deposit to a savings goal',
      tags: ['savings'],
      params: z.object({ goalId: z.string() }),
      body: z.object({
        amount: z.number().int().positive(),
      }),
    },
  }, async (request, reply) => {
    try {
      const { goalId } = request.params as { goalId: string };
      const { amount } = request.body as { amount: number };
      const result = await savingsService.depositToGoal((request as any).userId, goalId, amount);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.post('/goals/:goalId/withdraw', {
    preHandler: authenticateUser,
    schema: {
      description: 'Withdraw from a savings goal',
      tags: ['savings'],
      params: z.object({ goalId: z.string() }),
      body: z.object({
        amount: z.number().int().positive(),
      }),
    },
  }, async (request, reply) => {
    try {
      const { goalId } = request.params as { goalId: string };
      const { amount } = request.body as { amount: number };
      const result = await savingsService.withdrawFromGoal((request as any).userId, goalId, amount);
      return result;
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.delete('/goals/:goalId', {
    preHandler: authenticateUser,
    schema: {
      description: 'Cancel an empty savings goal',
      tags: ['savings'],
      params: z.object({ goalId: z.string() }),
    },
  }, async (request, reply) => {
    try {
      const { goalId } = request.params as { goalId: string };
      return savingsService.cancelGoal((request as any).userId, goalId);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // =========================================================================
  // AJO/ESUSU GROUPS
  // =========================================================================

  fastify.get('/ajo', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get user\'s ajo groups',
      tags: ['savings'],
    },
  }, async (request) => {
    return { groups: savingsService.getUserAjoGroups((request as any).userId) };
  });

  fastify.post('/ajo', {
    preHandler: authenticateUser,
    schema: {
      description: 'Create an ajo/esusu group',
      tags: ['savings'],
      body: z.object({
        name: z.string().min(1).max(100),
        contributionAmount: z.number().int().positive(),
        currency: z.string().default('NGN'),
        frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
        maxMembers: z.number().int().min(2).max(30),
      }),
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const result = savingsService.createAjoGroup((request as any).userId, body);
    return reply.code(201).send(result);
  });

  fastify.get('/ajo/:groupId', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get ajo group detail',
      tags: ['savings'],
      params: z.object({ groupId: z.string() }),
    },
  }, async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      return savingsService.getAjoGroup((request as any).userId, groupId);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.post('/ajo/join', {
    preHandler: authenticateUser,
    schema: {
      description: 'Join an ajo group via invite code',
      tags: ['savings'],
      body: z.object({
        inviteCode: z.string().min(4).max(20),
      }),
    },
  }, async (request, reply) => {
    try {
      const { inviteCode } = request.body as { inviteCode: string };
      const result = savingsService.joinAjoGroup((request as any).userId, inviteCode);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.post('/ajo/:groupId/contribute', {
    preHandler: authenticateUser,
    schema: {
      description: 'Make contribution to current round',
      tags: ['savings'],
      params: z.object({ groupId: z.string() }),
    },
  }, async (request, reply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const result = await savingsService.contributeToAjo((request as any).userId, groupId);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });
};
