/**
 * Collections & Invoicing Routes
 *
 * Endpoints at /api/b2b/invoicing
 */

import { FastifyPluginAsync } from 'fastify';
import {
    listInvoices,
    getInvoice,
    createInvoice,
    sendInvoice,
    recordPayment,
    cancelInvoice,
    getInvoicingSummary,
} from '../services/invoicing';

export const invoicingRoutes: FastifyPluginAsync = async (fastify) => {
    // ─── Summary ──────────────────────────────────────────────────────────────

    fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        return reply.send(await getInvoicingSummary(developerId));
    });

    // ─── List / Get ───────────────────────────────────────────────────────────

    fastify.get<{ Querystring: { status?: string } }>(
        '/',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            const list = await listInvoices(developerId, req.query.status);
            return reply.send({ invoices: list });
        },
    );

    fastify.get<{ Params: { id: string } }>(
        '/:id',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            return reply.send(await getInvoice(developerId, req.params.id));
        },
    );

    // ─── Create ───────────────────────────────────────────────────────────────

    fastify.post<{
        Body: {
            customerName: string;
            customerEmail?: string;
            customerPhone?: string;
            customerAddress?: string;
            currency?: string;
            taxRate?: number;
            discountAmount?: number;
            notes?: string;
            dueAt?: string;
            lineItems: { description: string; quantity: number; unitPrice: number }[];
        };
    }>('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { customerName, lineItems, dueAt, ...rest } = req.body;

        if (!customerName) return reply.status(400).send({ error: 'customerName is required' });
        if (!lineItems?.length) return reply.status(400).send({ error: 'At least one line item is required' });

        for (const li of lineItems) {
            if (!li.description || li.quantity <= 0 || li.unitPrice < 0) {
                return reply.status(400).send({ error: 'Each line item requires description, positive quantity, and non-negative unitPrice' });
            }
        }

        const invoice = await createInvoice(developerId, {
            customerName,
            ...rest,
            dueAt: dueAt ? new Date(dueAt) : undefined,
            lineItems,
        });
        return reply.status(201).send(invoice);
    });

    // ─── Actions ──────────────────────────────────────────────────────────────

    fastify.post<{ Params: { id: string } }>(
        '/:id/send',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            return reply.send(await sendInvoice(developerId, req.params.id));
        },
    );

    fastify.post<{ Params: { id: string }; Body: { amount: number } }>(
        '/:id/payment',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            const { amount } = req.body;
            if (!amount || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive integer (minor units)' });
            return reply.send(await recordPayment(developerId, req.params.id, amount));
        },
    );

    fastify.post<{ Params: { id: string } }>(
        '/:id/cancel',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            await cancelInvoice(developerId, req.params.id);
            return reply.status(204).send();
        },
    );
};
