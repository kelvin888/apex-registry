/**
 * B2B Routes
 *
 * Developer-authenticated endpoints for the B2B web portal.
 * All routes use `fastify.authenticate` (developer JWT or API key).
 * JWT payload: { id, email, role }
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as b2bService from '../services/b2b';

export const b2bRoutes: FastifyPluginAsync = async (fastify) => {
    // ─── Profile ──────────────────────────────────────────────────────────────

    fastify.get('/profile', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Get authenticated developer profile',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
        },
    }, async (request) => {
        const dev = request.user as { id: string; email: string; role: string };
        return b2bService.getDeveloperProfile(dev.id);
    });

    // ─── Wallet ────────────────────────────────────────────────────────────────

    fastify.get('/wallet', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Get B2B wallet balance',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    currency: { type: 'string', minLength: 3, maxLength: 3 },
                },
            },
        },
    }, async (request) => {
        const dev = request.user as { id: string };
        const { currency } = z
            .object({ currency: z.string().length(3).toUpperCase().optional() })
            .parse(request.query);
        return b2bService.getWallet(dev.id, currency);
    });

    fastify.get('/wallet/transactions', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Get B2B transaction history',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100 },
                    offset: { type: 'integer', minimum: 0 },
                    currency: { type: 'string', minLength: 3, maxLength: 3 },
                },
            },
        },
    }, async (request) => {
        const dev = request.user as { id: string };
        const params = z
            .object({
                limit: z.coerce.number().int().min(1).max(100).optional(),
                offset: z.coerce.number().int().min(0).optional(),
                currency: z.string().length(3).toUpperCase().optional(),
            })
            .parse(request.query);
        return b2bService.getTransactions(dev.id, params);
    });

    fastify.post('/wallet/fund', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Fund B2B wallet (sandbox / test endpoint)',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['amount', 'currency'],
                properties: {
                    amount: { type: 'integer', minimum: 100 },
                    currency: { type: 'string', minLength: 3, maxLength: 3 },
                    description: { type: 'string' },
                },
            },
        },
    }, async (request) => {
        const dev = request.user as { id: string };
        const params = z
            .object({
                amount: z.number().int().min(100),
                currency: z.string().length(3).toUpperCase(),
                description: z.string().max(200).optional(),
            })
            .parse(request.body);
        return b2bService.createTransaction(dev.id, { ...params, type: 'fund' });
    });

    // ─── KYB ───────────────────────────────────────────────────────────────────

    fastify.get('/kyb', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Get B2B KYB verification status',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
        },
    }, async (request) => {
        const dev = request.user as { id: string };
        return b2bService.getKybStatus(dev.id);
    });

    fastify.post('/kyb/submit', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Submit B2B KYB verification',
            tags: ['b2b'],
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['businessName'],
                properties: {
                    businessName: { type: 'string', minLength: 1 },
                    registrationNumber: { type: 'string' },
                    taxId: { type: 'string' },
                    country: { type: 'string', minLength: 2, maxLength: 2 },
                    businessType: {
                        type: 'string',
                        enum: ['sole_proprietor', 'llc', 'plc', 'ngo', 'cooperative'],
                    },
                },
            },
        },
    }, async (request) => {
        const dev = request.user as { id: string };
        const params = z
            .object({
                businessName: z.string().min(1).max(200),
                registrationNumber: z.string().optional(),
                taxId: z.string().optional(),
                country: z.string().length(2).toUpperCase().optional(),
                businessType: z
                    .enum(['sole_proprietor', 'llc', 'plc', 'ngo', 'cooperative'])
                    .optional(),
            })
            .parse(request.body);
        return b2bService.submitKyb(dev.id, params);
    });
};
