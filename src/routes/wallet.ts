/**
 * Wallet Routes
 *
 * End-user wallet endpoints: balance, fund, transfer, pay, history.
 * All endpoints require user JWT (scope: 'user').
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as walletService from '../services/wallet';

export const walletRoutes: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // USER AUTH DECORATOR — same pattern as identity routes
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
  // BALANCE
  // =========================================================================

  fastify.get('/balance', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get wallet balance',
      tags: ['wallet'],
      querystring: {
        type: 'object',
        properties: {
          currency: { type: 'string', minLength: 3, maxLength: 3 },
        },
      },
    },
  }, async (request) => {
    const { currency } = z
      .object({ currency: z.string().length(3).toUpperCase().optional() })
      .parse(request.query);
    return walletService.getBalance(request.userId!, currency);
  });

  // =========================================================================
  // FUND WALLET
  // =========================================================================

  fastify.post('/fund', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Fund wallet from external source',
      tags: ['wallet'],
      body: {
        type: 'object',
        required: ['amount', 'currency', 'source'],
        properties: {
          amount: { type: 'integer', minimum: 100 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          source: { type: 'string', enum: ['card', 'bank_transfer', 'ussd'] },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        amount: z.number().int().min(100),
        currency: z.string().length(3).toUpperCase(),
        source: z.enum(['card', 'bank_transfer', 'ussd']),
      })
      .parse(request.body);

    return walletService.fundWallet(request.userId!, params);
  });

  // =========================================================================
  // TRANSFER
  // =========================================================================

  fastify.post('/transfer', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Transfer funds (wallet-to-wallet or bank)',
      tags: ['wallet'],
      body: {
        type: 'object',
        required: ['amount', 'currency', 'recipientType'],
        properties: {
          amount: { type: 'integer', minimum: 100 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          recipientType: { type: 'string', enum: ['wallet', 'bank'] },
          recipientId: { type: 'string' },
          bankCode: { type: 'string' },
          accountNumber: { type: 'string' },
          narration: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        amount: z.number().int().min(100),
        currency: z.string().length(3).toUpperCase(),
        recipientType: z.enum(['wallet', 'bank']),
        recipientId: z.string().optional(),
        bankCode: z.string().optional(),
        accountNumber: z.string().optional(),
        narration: z.string().max(200).optional(),
      })
      .parse(request.body);

    return walletService.initiateTransfer(request.userId!, params);
  });

  // =========================================================================
  // PAY (mini-app payment)
  // =========================================================================

  fastify.post('/pay', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Process a payment (debit wallet)',
      tags: ['wallet'],
      body: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'integer', minimum: 1 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          description: { type: 'string', maxLength: 200 },
          merchantId: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        amount: z.number().int().min(1),
        currency: z.string().length(3).toUpperCase(),
        description: z.string().max(200).optional(),
        merchantId: z.string().optional(),
      })
      .parse(request.body);

    return walletService.processPayment(request.userId!, params);
  });

  // =========================================================================
  // TRANSACTION HISTORY
  // =========================================================================

  fastify.get('/transactions', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get transaction history',
      tags: ['wallet'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
          type: { type: 'string', enum: ['fund', 'withdraw', 'transfer', 'payment', 'refund', 'loan_disbursement', 'loan_repayment'] },
          startDate: { type: 'integer' },
          endDate: { type: 'integer' },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
        },
      },
    },
  }, async (request) => {
    const params = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        type: z.enum(['fund', 'withdraw', 'transfer', 'payment', 'refund', 'loan_disbursement', 'loan_repayment']).optional(),
        startDate: z.coerce.number().optional(),
        endDate: z.coerce.number().optional(),
        currency: z.string().length(3).toUpperCase().optional(),
      })
      .parse(request.query);

    return walletService.getTransactionHistory(request.userId!, params);
  });
};
