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
      querystring: {
        type: 'object',
        properties: {
          country: { type: 'string', default: 'NG' },
        },
      },
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
      body: {
        type: 'object',
        required: ['identifier'],
        properties: {
          identifier: { type: 'string', minLength: 3 },
        },
      },
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
      body: {
        type: 'object',
        required: ['bankCode', 'accountNumber'],
        properties: {
          bankCode: { type: 'string', minLength: 3, maxLength: 3 },
          accountNumber: { type: 'string', minLength: 10, maxLength: 10 },
        },
      },
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
      body: {
        type: 'object',
        required: ['recipientId', 'amount'],
        properties: {
          recipientId: { type: 'string' },
          amount: { type: 'integer', minimum: 1 },
          currency: { type: 'string', default: 'NGN' },
          narration: { type: 'string' },
          saveBeneficiary: { type: 'boolean', default: false },
        },
      },
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
      body: {
        type: 'object',
        required: ['bankCode', 'accountNumber', 'accountName', 'amount'],
        properties: {
          bankCode: { type: 'string', minLength: 3, maxLength: 3 },
          accountNumber: { type: 'string', minLength: 10, maxLength: 10 },
          accountName: { type: 'string' },
          amount: { type: 'integer', minimum: 1 },
          currency: { type: 'string', default: 'NGN' },
          narration: { type: 'string' },
          saveBeneficiary: { type: 'boolean', default: false },
        },
      },
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
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
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
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['wallet', 'bank'] },
          search: { type: 'string' },
        },
      },
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
      body: {
        type: 'object',
        required: ['type', 'accountId', 'accountName'],
        properties: {
          type: { type: 'string', enum: ['wallet', 'bank'] },
          accountId: { type: 'string' },
          accountName: { type: 'string' },
          bankCode: { type: 'string' },
          bankName: { type: 'string' },
          alias: { type: 'string' },
        },
      },
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
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
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
      body: {
        type: 'object',
        required: ['payload'],
        properties: {
          payload: { type: 'string' },
        },
      },
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
