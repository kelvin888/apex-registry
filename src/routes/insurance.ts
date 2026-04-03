/**
 * Insurance Routes
 *
 * Plan browsing, enrollment, premium payments, claims management.
 * Mutation endpoints require user JWT.
 */

import { FastifyPluginAsync } from 'fastify';
import * as insuranceService from '../services/insurance';

export const insuranceRoutes: FastifyPluginAsync = async (fastify) => {
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
  // PLANS
  // =========================================================================

  fastify.get('/plans', async (request) => {
    const q = request.query as any;
    const plans = insuranceService.getPlans({
      country: q.country || 'NG',
      type: q.type,
      coverageLevel: q.coverageLevel,
    });
    return { plans };
  });

  fastify.get('/plans/:planId', async (request, reply) => {
    const { planId } = request.params as any;
    const plan = insuranceService.getPlan(planId);
    if (!plan) {
      reply.code(404).send({ error: 'Plan not found' });
      return;
    }
    return { plan };
  });

  // =========================================================================
  // ENROLLMENT
  // =========================================================================

  fastify.post('/enroll', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { planId } = request.body as any;
    if (!planId) {
      reply.code(400).send({ error: 'planId is required' });
      return;
    }
    try {
      return insuranceService.enroll((request as any).userId, planId);
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/enrollment', { preHandler: [authenticateUser] }, async (request) => {
    const enrollment = insuranceService.getEnrollment((request as any).userId);
    return { enrollment };
  });

  fastify.post('/premium/pay', { preHandler: [authenticateUser] }, async (request, reply) => {
    try {
      return insuranceService.payPremium((request as any).userId);
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.delete('/enrollment', { preHandler: [authenticateUser] }, async (request, reply) => {
    try {
      return insuranceService.cancelEnrollment((request as any).userId);
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  // =========================================================================
  // CLAIMS
  // =========================================================================

  fastify.post('/claims', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { type, description, amount, evidenceUrls, appointmentId } = request.body as any;
    if (!type || !description || !amount) {
      reply.code(400).send({ error: 'type, description, and amount are required' });
      return;
    }
    try {
      return insuranceService.submitClaim({
        userId: (request as any).userId,
        type,
        description,
        amount,
        evidenceUrls,
        appointmentId,
      });
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/claims', { preHandler: [authenticateUser] }, async (request) => {
    const claims = insuranceService.getClaims((request as any).userId);
    return { claims };
  });

  fastify.get('/claims/:claimId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { claimId } = request.params as any;
    const claim = insuranceService.getClaim(claimId);
    if (!claim) {
      reply.code(404).send({ error: 'Claim not found' });
      return;
    }
    return { claim };
  });
};
