/**
 * Cross-border Payments Routes
 *
 * Endpoints at /api/b2b/crossborder
 */

import { FastifyPluginAsync } from 'fastify';
import {
    SUPPORTED_CORRIDORS,
    getQuote,
    listRecipients,
    createRecipient,
    deleteRecipient,
    listTransfers,
    initiateTransfer,
    getTransferSummary,
} from '../services/crossborder';

export const crossborderRoutes: FastifyPluginAsync = async (fastify) => {
    // ─── Meta ─────────────────────────────────────────────────────────────────

    fastify.get('/corridors', { preHandler: [fastify.authenticate] }, async (_req, reply) => {
        return reply.send({ corridors: SUPPORTED_CORRIDORS });
    });

    fastify.get<{
        Querystring: { from: string; to: string; amount: string };
    }>('/quote', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { from, to, amount } = req.query;
        if (!from || !to || !amount) {
            return reply.status(400).send({ error: 'from, to, and amount are required' });
        }
        const parsed = parseInt(amount, 10);
        if (isNaN(parsed) || parsed <= 0) {
            return reply.status(400).send({ error: 'amount must be a positive integer (minor units)' });
        }
        const quote = getQuote(from, to, parsed);
        return reply.send(quote);
    });

    // ─── Summary ──────────────────────────────────────────────────────────────

    fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const summary = await getTransferSummary(developerId);
        return reply.send(summary);
    });

    // ─── Recipients ───────────────────────────────────────────────────────────

    fastify.get('/recipients', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const recipients = await listRecipients(developerId);
        return reply.send({ recipients });
    });

    fastify.post<{
        Body: {
            alias: string;
            fullName: string;
            country: string;
            currency: string;
            type: 'bank_account' | 'mobile_wallet' | 'cash_pickup';
            accountNumber: string;
            bankName?: string;
            bankCode?: string;
            routingNumber?: string;
            swiftCode?: string;
            ibanNumber?: string;
            mobileWalletProvider?: string;
            mobileWalletNumber?: string;
        };
    }>('/recipients', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { alias, fullName, country, currency, type, accountNumber } = req.body;
        if (!alias || !fullName || !country || !currency || !type || !accountNumber) {
            return reply.status(400).send({ error: 'alias, fullName, country, currency, type, and accountNumber are required' });
        }
        const recipient = await createRecipient(developerId, req.body);
        return reply.status(201).send(recipient);
    });

    fastify.delete<{ Params: { id: string } }>(
        '/recipients/:id',
        { preHandler: [fastify.authenticate] },
        async (req, reply) => {
            const { id: developerId } = req.user as { id: string };
            await deleteRecipient(developerId, req.params.id);
            return reply.status(204).send();
        },
    );

    // ─── Transfers ────────────────────────────────────────────────────────────

    fastify.get<{
        Querystring: { status?: string };
    }>('/transfers', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const transfers = await listTransfers(developerId, { status: req.query.status });
        return reply.send({ transfers });
    });

    fastify.post<{
        Body: {
            recipientId?: string;
            sendAmount: number;
            sendCurrency: string;
            receiveCurrency: string;
            recipientName: string;
            recipientCountry: string;
            recipientAccount: string;
            purpose: 'business_payment' | 'salary' | 'invoice' | 'supplier' | 'family_support' | 'other';
            narration?: string;
        };
    }>('/transfers', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { sendAmount, sendCurrency, receiveCurrency, recipientName, recipientCountry, recipientAccount, purpose } = req.body;

        if (!sendAmount || !sendCurrency || !receiveCurrency || !recipientName || !recipientCountry || !recipientAccount || !purpose) {
            return reply.status(400).send({ error: 'sendAmount, sendCurrency, receiveCurrency, recipientName, recipientCountry, recipientAccount, and purpose are required' });
        }

        const transfer = await initiateTransfer(developerId, req.body);
        return reply.status(201).send(transfer);
    });
};
