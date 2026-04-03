/**
 * Fleet Routes
 *
 * B2B fleet & fuel management endpoints. All require developer JWT.
 * Prefix: /api/b2b/fleet
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as fleetService from '../services/fleet';

export const fleetRoutes: FastifyPluginAsync = async (fastify) => {
    const auth = [fastify.authenticate];
    const dev = (request: any) => request.user as { id: string };

    // ─── Summary ──────────────────────────────────────────────────────────────

    fastify.get('/summary', {
        onRequest: auth,
        schema: { description: 'Fleet summary KPIs', tags: ['b2b', 'fleet'], security: [{ bearerAuth: [] }] },
    }, async (request) => {
        return fleetService.getFleetSummary(dev(request).id);
    });

    // ─── Vehicles ─────────────────────────────────────────────────────────────

    fastify.get('/vehicles', {
        onRequest: auth,
        schema: { description: 'List all vehicles', tags: ['b2b', 'fleet'], security: [{ bearerAuth: [] }] },
    }, async (request) => {
        return fleetService.listVehicles(dev(request).id);
    });

    fastify.get('/vehicles/:id', {
        onRequest: auth,
        schema: {
            description: 'Get vehicle detail',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
    }, async (request) => {
        const { id } = request.params as { id: string };
        return fleetService.getVehicle(dev(request).id, id);
    });

    fastify.post('/vehicles', {
        onRequest: auth,
        schema: {
            description: 'Register a new vehicle',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['plateNumber', 'make', 'model'],
                properties: {
                    plateNumber: { type: 'string' },
                    make: { type: 'string' },
                    model: { type: 'string' },
                    year: { type: 'integer' },
                    fuelType: { type: 'string', enum: ['petrol', 'diesel', 'electric', 'hybrid', 'cng'] },
                    assignedDriverName: { type: 'string' },
                    assignedDriverPhone: { type: 'string' },
                },
            },
        },
    }, async (request) => {
        const params = z.object({
            plateNumber: z.string().min(1),
            make: z.string().min(1),
            model: z.string().min(1),
            year: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
            fuelType: z.enum(['petrol', 'diesel', 'electric', 'hybrid', 'cng']).optional(),
            assignedDriverName: z.string().optional(),
            assignedDriverPhone: z.string().optional(),
        }).parse(request.body);
        return fleetService.createVehicle(dev(request).id, params);
    });

    fastify.patch('/vehicles/:id', {
        onRequest: auth,
        schema: {
            description: 'Update vehicle status or driver assignment',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
    }, async (request) => {
        const { id } = request.params as { id: string };
        const params = z.object({
            status: z.enum(['active', 'inactive', 'maintenance']).optional(),
            assignedDriverName: z.string().optional(),
            assignedDriverPhone: z.string().optional(),
            odometer: z.number().int().min(0).optional(),
        }).parse(request.body);
        return fleetService.updateVehicle(dev(request).id, id, params);
    });

    // ─── Fuel Cards ───────────────────────────────────────────────────────────

    fastify.get('/fuel-cards', {
        onRequest: auth,
        schema: { description: 'List fuel cards', tags: ['b2b', 'fleet'], security: [{ bearerAuth: [] }] },
    }, async (request) => {
        return fleetService.listFuelCards(dev(request).id);
    });

    fastify.post('/fuel-cards', {
        onRequest: auth,
        schema: {
            description: 'Issue a new fuel card',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['cardNumber'],
                properties: {
                    cardNumber: { type: 'string' },
                    vehicleId: { type: 'string' },
                    provider: { type: 'string' },
                    spendLimit: { type: 'integer' },
                    currency: { type: 'string' },
                },
            },
        },
    }, async (request) => {
        const params = z.object({
            cardNumber: z.string().min(1),
            vehicleId: z.string().optional(),
            provider: z.string().optional(),
            spendLimit: z.number().int().min(1).optional(),
            currency: z.string().length(3).toUpperCase().optional(),
        }).parse(request.body);
        return fleetService.createFuelCard(dev(request).id, params);
    });

    fastify.post('/fuel-cards/:id/topup', {
        onRequest: auth,
        schema: {
            description: 'Top up a fuel card balance',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['amount'],
                properties: { amount: { type: 'integer', minimum: 100 } },
            },
        },
    }, async (request) => {
        const { id } = request.params as { id: string };
        const { amount } = z.object({ amount: z.number().int().min(100) }).parse(request.body);
        return fleetService.topupFuelCard(dev(request).id, id, amount);
    });

    // ─── Transactions ─────────────────────────────────────────────────────────

    fastify.get('/transactions', {
        onRequest: auth,
        schema: {
            description: 'Fleet transaction history',
            tags: ['b2b', 'fleet'],
            security: [{ bearerAuth: [] }],
            querystring: {
                type: 'object',
                properties: {
                    vehicleId: { type: 'string' },
                    limit: { type: 'integer', minimum: 1, maximum: 100 },
                    offset: { type: 'integer', minimum: 0 },
                },
            },
        },
    }, async (request) => {
        const params = z.object({
            vehicleId: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            offset: z.coerce.number().int().min(0).optional(),
        }).parse(request.query);
        return fleetService.listTransactions(dev(request).id, params);
    });
};
