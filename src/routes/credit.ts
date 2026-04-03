/**
 * Credit Routes
 *
 * mKudi Credit Engine endpoints: credit score, loan request/accept/status/repay.
 * All endpoints require user JWT (scope: 'user').
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as creditService from '../services/credit';

export const creditRoutes: FastifyPluginAsync = async (fastify) => {
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
  // CREDIT SCORE
  // =========================================================================

  fastify.get('/score', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get credit score',
      tags: ['credit'],
    },
  }, async (request) => {
    return creditService.getCreditScore(request.userId!);
  });

  // =========================================================================
  // REQUEST LOAN (generate offer)
  // =========================================================================

  fastify.post('/request', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Request a loan offer',
      tags: ['credit'],
      body: {
        type: 'object',
        required: ['product', 'amount', 'currency', 'tenorDays'],
        properties: {
          product: { type: 'string', enum: ['nano_loan', 'working_capital', 'invoice_financing', 'merchant_advance'] },
          amount: { type: 'integer', minimum: 1 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          tenorDays: { type: 'integer', minimum: 1, maximum: 365 },
          purpose: { type: 'string', maxLength: 500 },
          invoiceRefs: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        product: z.enum(['nano_loan', 'working_capital', 'invoice_financing', 'merchant_advance']),
        amount: z.number().int().min(1),
        currency: z.string().length(3).toUpperCase(),
        tenorDays: z.number().int().min(1).max(365),
        purpose: z.string().max(500).optional(),
        invoiceRefs: z.array(z.string()).max(20).optional(),
      })
      .parse(request.body);

    return creditService.requestLoan(request.userId!, params);
  });

  // =========================================================================
  // ACCEPT LOAN
  // =========================================================================

  fastify.post('/accept', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Accept a loan offer — triggers disbursement',
      tags: ['credit'],
      body: {
        type: 'object',
        required: ['offerId'],
        properties: {
          offerId: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({ offerId: z.string().min(1) })
      .parse(request.body);

    return creditService.acceptLoan(request.userId!, params);
  });

  // =========================================================================
  // LOAN STATUS
  // =========================================================================

  fastify.get('/loan/:loanId', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get loan status and details',
      tags: ['credit'],
      params: {
        type: 'object',
        required: ['loanId'],
        properties: {
          loanId: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { loanId } = z
      .object({ loanId: z.string().min(1) })
      .parse(request.params);

    return creditService.getLoanStatus(request.userId!, { loanId });
  });

  // =========================================================================
  // REPAY LOAN
  // =========================================================================

  fastify.post('/repay', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Repay a loan (full or partial)',
      tags: ['credit'],
      body: {
        type: 'object',
        required: ['loanId'],
        properties: {
          loanId: { type: 'string' },
          amount: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        loanId: z.string().min(1),
        amount: z.number().int().min(1).optional(),
      })
      .parse(request.body);

    return creditService.repayLoan(request.userId!, params);
  });
};
