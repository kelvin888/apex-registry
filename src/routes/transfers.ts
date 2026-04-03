/**
 * Transfers Routes
 *
 * P2P wallet-to-wallet, bank transfers, beneficiary management,
 * bank directory, QR transfers.
 * All mutation endpoints require user JWT.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as transfersService from '../services/transfers';

export const transfersRoutes: FastifyPluginAsync = async (fastify) => {
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
  // BANK DIRECTORY — PUBLIC
  // =========================================================================

  fastify.get('/banks', {
    schema: {
      description: 'List supported banks',
      tags: ['transfers'],
      querystring: z.object({ country: z.string().default('NG') }),
    },
  }, async (request) => {
    const { country } = request.query as { country: string };
    return { banks: transfersService.getBanks(country) };
  });

  // =========================================================================
  // LOOKUP — AUTHENTICATED
  // =========================================================================

  fastify.post('/lookup/wallet', {
    preHandler: authenticateUser,
    schema: {
      description: 'Look up wallet recipient by phone or email',
      tags: ['transfers'],
      body: z.object({
        identifier: z.string().min(3),
      }),
    },
  }, async (request, reply) => {
    const { identifier } = request.body as { identifier: string };
    const result = transfersService.lookupWalletRecipient(identifier);
    if (!result) return reply.code(404).send({ error: 'User not found' });
    return result;
  });

  fastify.post('/lookup/bank', {
    preHandler: authenticateUser,
    schema: {
      description: 'Name enquiry for bank account',
      tags: ['transfers'],
      body: z.object({
        bankCode: z.string().length(3),
        accountNumber: z.string().length(10),
      }),
    },
  }, async (request) => {
    const { bankCode, accountNumber } = request.body as { bankCode: string; accountNumber: string };
    return transfersService.lookupBankAccount(bankCode, accountNumber);
  });

  // =========================================================================
  // SEND — AUTHENTICATED
  // =========================================================================

  fastify.post('/send/wallet', {
    preHandler: authenticateUser,
    schema: {
      description: 'Send money to an Apex wallet',
      tags: ['transfers'],
      body: z.object({
        recipientId: z.string(),
        amount: z.number().int().positive(),
        currency: z.string().default('NGN'),
        narration: z.string().optional(),
        saveBeneficiary: z.boolean().default(false),
      }),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as any;
      const result = await transfersService.sendToWallet((request as any).userId, body);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.post('/send/bank', {
    preHandler: authenticateUser,
    schema: {
      description: 'Send money to a bank account',
      tags: ['transfers'],
      body: z.object({
        bankCode: z.string().length(3),
        accountNumber: z.string().length(10),
        accountName: z.string(),
        amount: z.number().int().positive(),
        currency: z.string().default('NGN'),
        narration: z.string().optional(),
        saveBeneficiary: z.boolean().default(false),
      }),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as any;
      const result = await transfersService.sendToBank((request as any).userId, body);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // =========================================================================
  // TRANSFER HISTORY
  // =========================================================================

  fastify.get('/history', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get transfer history',
      tags: ['transfers'],
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
  }, async (request) => {
    const { limit, offset } = request.query as { limit: number; offset: number };
    return transfersService.getTransferHistory((request as any).userId, { limit, offset });
  });

  // =========================================================================
  // BENEFICIARIES
  // =========================================================================

  fastify.get('/beneficiaries', {
    preHandler: authenticateUser,
    schema: {
      description: 'Get saved beneficiaries',
      tags: ['transfers'],
      querystring: z.object({
        type: z.enum(['wallet', 'bank']).optional(),
        search: z.string().optional(),
      }),
    },
  }, async (request) => {
    const query = request.query as { type?: 'wallet' | 'bank'; search?: string };
    return { beneficiaries: transfersService.getBeneficiaries((request as any).userId, query) };
  });

  fastify.post('/beneficiaries', {
    preHandler: authenticateUser,
    schema: {
      description: 'Save a beneficiary',
      tags: ['transfers'],
      body: z.object({
        type: z.enum(['wallet', 'bank']),
        accountId: z.string(),
        accountName: z.string(),
        bankCode: z.string().optional(),
        bankName: z.string().optional(),
        alias: z.string().optional(),
      }),
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const id = await transfersService.upsertBeneficiary((request as any).userId, body);
    return reply.code(201).send({ id });
  });

  fastify.delete('/beneficiaries/:id', {
    preHandler: authenticateUser,
    schema: {
      description: 'Delete a beneficiary',
      tags: ['transfers'],
      params: z.object({ id: z.string() }),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return transfersService.deleteBeneficiary((request as any).userId, id);
    } catch (err: any) {
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // =========================================================================
  // QR TRANSFER
  // =========================================================================

  fastify.get('/qr/generate', {
    preHandler: authenticateUser,
    schema: {
      description: 'Generate QR code payload for receiving transfers',
      tags: ['transfers'],
    },
  }, async (request) => {
    return transfersService.generateQRPayload((request as any).userId);
  });

  fastify.post('/qr/parse', {
    preHandler: authenticateUser,
    schema: {
      description: 'Parse a scanned QR payload',
      tags: ['transfers'],
      body: z.object({ payload: z.string() }),
    },
  }, async (request, reply) => {
    const { payload } = request.body as { payload: string };
    const result = transfersService.parseQRPayload(payload);
    if (!result) return reply.code(400).send({ error: 'Invalid QR code' });

    // Look up the user
    const recipient = transfersService.lookupWalletRecipient(result.userId);
    return recipient || reply.code(404).send({ error: 'User not found' });
  });
};
