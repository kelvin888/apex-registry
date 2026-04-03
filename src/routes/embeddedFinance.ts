import { FastifyInstance } from 'fastify';
import {
    listWallets,
    getWallet,
    createWallet,
    updateWalletStatus,
    creditWallet,
    debitWallet,
    transferBetweenWallets,
    listWalletTransactions,
    listWebhooks,
    createWebhook,
    deleteWebhook,
    getFinanceSummary,
    WEBHOOK_EVENTS,
} from '../services/embeddedFinance';

export async function embeddedFinanceRoutes(fastify: FastifyInstance) {
    // Summary
    fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        return getFinanceSummary(dev.id);
    });

    // Wallets — list / create
    fastify.get('/wallets', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        return listWallets(dev.id);
    });

    fastify.post('/wallets', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const body = request.body as {
            externalCustomerId: string;
            customerName: string;
            customerEmail?: string;
            customerPhone?: string;
            currency?: string;
            tier?: 'basic' | 'standard' | 'premium';
            dailyTxnLimit?: number;
        };
        const wallet = await createWallet(dev.id, body);
        return reply.code(201).send(wallet);
    });

    // Wallet — get single
    fastify.get('/wallets/:id', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        return getWallet(dev.id, id);
    });

    // Wallet — status update
    fastify.patch('/wallets/:id/status', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        const { status } = request.body as { status: 'active' | 'frozen' | 'closed' };
        return updateWalletStatus(dev.id, id, status);
    });

    // Wallet — credit
    fastify.post('/wallets/:id/credit', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        const { amount, narration, metadata } = request.body as { amount: number; narration?: string; metadata?: object };
        const txn = await creditWallet(dev.id, id, amount, narration, metadata);
        return reply.code(201).send(txn);
    });

    // Wallet — debit
    fastify.post('/wallets/:id/debit', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        const { amount, narration, metadata } = request.body as { amount: number; narration?: string; metadata?: object };
        const txn = await debitWallet(dev.id, id, amount, narration, metadata);
        return reply.code(201).send(txn);
    });

    // Wallet — wallet-to-wallet transfer
    fastify.post('/wallets/:id/transfer', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        const { toWalletId, amount, narration } = request.body as { toWalletId: string; amount: number; narration?: string };
        const txn = await transferBetweenWallets(dev.id, id, toWalletId, amount, narration);
        return reply.code(201).send(txn);
    });

    // Wallet — transactions
    fastify.get('/wallets/:id/transactions', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        return listWalletTransactions(dev.id, id);
    });

    // Webhooks — list / register
    fastify.get('/webhooks', { preHandler: [fastify.authenticate] }, async (request) => {
        const dev = (request.user as any);
        const rows = await listWebhooks(dev.id);
        return rows.map((r) => ({ ...r, events: JSON.parse(r.events as string) }));
    });

    fastify.post('/webhooks', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const { url, events } = request.body as { url: string; events: string[] };
        const webhook = await createWebhook(dev.id, url, events);
        return reply.code(201).send({ ...webhook, events: JSON.parse(webhook.events as string) });
    });

    fastify.delete('/webhooks/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const dev = (request.user as any);
        const { id } = request.params as { id: string };
        await deleteWebhook(dev.id, id);
        return reply.code(204).send();
    });

    // Supported event types
    fastify.get('/webhooks/events', { preHandler: [fastify.authenticate] }, async () => {
        return { events: WEBHOOK_EVENTS };
    });
}
