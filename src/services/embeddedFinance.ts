/**
 * Embedded Finance Service
 *
 * Issue and manage customer wallets on behalf of developers. Supports
 * crediting/debiting wallets, peer transfers between wallets, and
 * webhook registration for real-time event delivery.
 */

import { eq, desc, and, sum } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, embeddedWallets, embeddedTransactions, embeddedWebhooks } from '../db';
import crypto from 'crypto';

// ─── Wallets ──────────────────────────────────────────────────────────────────

export async function listWallets(developerId: string) {
    const db = getDatabase();
    return db.select().from(embeddedWallets).where(eq(embeddedWallets.developerId, developerId)).orderBy(desc(embeddedWallets.createdAt));
}

export async function getWallet(developerId: string, walletId: string) {
    const db = getDatabase();
    const wallet = await db
        .select()
        .from(embeddedWallets)
        .where(and(eq(embeddedWallets.id, walletId), eq(embeddedWallets.developerId, developerId)))
        .get();
    if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
    return wallet;
}

export async function createWallet(
    developerId: string,
    params: {
        externalCustomerId: string;
        customerName: string;
        customerEmail?: string;
        customerPhone?: string;
        currency?: string;
        tier?: 'basic' | 'standard' | 'premium';
        dailyTxnLimit?: number;
    },
) {
    const db = getDatabase();
    const now = new Date();
    const wallet = {
        id: nanoid(),
        developerId,
        externalCustomerId: params.externalCustomerId,
        customerName: params.customerName,
        customerEmail: params.customerEmail ?? null,
        customerPhone: params.customerPhone ?? null,
        currency: params.currency ?? 'NGN',
        balance: 0,
        ledgerBalance: 0,
        status: 'active' as const,
        tier: params.tier ?? 'basic',
        dailyTxnLimit: params.dailyTxnLimit ?? 50000000,
        createdAt: now,
        updatedAt: now,
    };
    await db.insert(embeddedWallets).values(wallet);
    return wallet;
}

export async function updateWalletStatus(
    developerId: string,
    walletId: string,
    status: 'active' | 'frozen' | 'closed',
) {
    await getWallet(developerId, walletId);
    const db = getDatabase();
    await db.update(embeddedWallets).set({ status, updatedAt: new Date() }).where(eq(embeddedWallets.id, walletId));
    return getWallet(developerId, walletId);
}

// ─── Transactions ─────────────────────────────────────────────────────────────

async function postEntry(
    developerId: string,
    walletId: string,
    type: 'credit' | 'debit' | 'transfer_in' | 'transfer_out' | 'fee' | 'reversal',
    amount: number,
    narration?: string,
    metadata?: object,
) {
    const db = getDatabase();
    const wallet = await db.select().from(embeddedWallets).where(eq(embeddedWallets.id, walletId)).get();
    if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
    if (wallet.status !== 'active') throw Object.assign(new Error(`Wallet is ${wallet.status}`), { statusCode: 422 });

    const isCredit = type === 'credit' || type === 'transfer_in' || type === 'reversal';
    const newBalance = isCredit ? wallet.balance + amount : wallet.balance - amount;
    if (newBalance < 0) throw Object.assign(new Error('Insufficient balance'), { statusCode: 422 });

    const now = new Date();
    const txn = {
        id: nanoid(),
        developerId,
        walletId,
        type,
        amount,
        currency: wallet.currency,
        balanceBefore: wallet.balance,
        balanceAfter: newBalance,
        reference: `EMB-${Date.now()}-${nanoid(6).toUpperCase()}`,
        narration: narration ?? null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        status: 'completed' as const,
        createdAt: now,
    };

    await db.insert(embeddedTransactions).values(txn);
    await db.update(embeddedWallets).set({ balance: newBalance, ledgerBalance: newBalance, updatedAt: now }).where(eq(embeddedWallets.id, walletId));

    return txn;
}

export async function creditWallet(developerId: string, walletId: string, amount: number, narration?: string, metadata?: object) {
    await getWallet(developerId, walletId);
    return postEntry(developerId, walletId, 'credit', amount, narration, metadata);
}

export async function debitWallet(developerId: string, walletId: string, amount: number, narration?: string, metadata?: object) {
    await getWallet(developerId, walletId);
    return postEntry(developerId, walletId, 'debit', amount, narration, metadata);
}

export async function transferBetweenWallets(
    developerId: string,
    fromWalletId: string,
    toWalletId: string,
    amount: number,
    narration?: string,
) {
    await getWallet(developerId, fromWalletId);
    await getWallet(developerId, toWalletId);

    const out = await postEntry(developerId, fromWalletId, 'transfer_out', amount, narration ?? 'Wallet transfer');
    await postEntry(developerId, toWalletId, 'transfer_in', amount, narration ?? 'Wallet transfer');
    return out;
}

export async function listWalletTransactions(developerId: string, walletId: string) {
    await getWallet(developerId, walletId);
    const db = getDatabase();
    return db
        .select()
        .from(embeddedTransactions)
        .where(and(eq(embeddedTransactions.developerId, developerId), eq(embeddedTransactions.walletId, walletId)))
        .orderBy(desc(embeddedTransactions.createdAt));
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
    'wallet.created',
    'wallet.status_changed',
    'transaction.credit',
    'transaction.debit',
    'transaction.transfer',
];

export async function listWebhooks(developerId: string) {
    const db = getDatabase();
    return db.select().from(embeddedWebhooks).where(eq(embeddedWebhooks.developerId, developerId)).orderBy(desc(embeddedWebhooks.createdAt));
}

export async function createWebhook(developerId: string, url: string, events: string[]) {
    const db = getDatabase();
    const now = new Date();
    const webhook = {
        id: nanoid(),
        developerId,
        url,
        secret: `whsec_${crypto.randomBytes(24).toString('hex')}`,
        events: JSON.stringify(events),
        isActive: true,
        lastDeliveredAt: null,
        createdAt: now,
        updatedAt: now,
    };
    await db.insert(embeddedWebhooks).values(webhook);
    return webhook;
}

export async function deleteWebhook(developerId: string, webhookId: string) {
    const db = getDatabase();
    const row = await db.select().from(embeddedWebhooks).where(and(eq(embeddedWebhooks.id, webhookId), eq(embeddedWebhooks.developerId, developerId))).get();
    if (!row) throw Object.assign(new Error('Webhook not found'), { statusCode: 404 });
    await db.update(embeddedWebhooks).set({ isActive: false, updatedAt: new Date() }).where(eq(embeddedWebhooks.id, webhookId));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getFinanceSummary(developerId: string) {
    const db = getDatabase();
    const walletRows = await db.select({ status: embeddedWallets.status, balance: embeddedWallets.balance }).from(embeddedWallets).where(eq(embeddedWallets.developerId, developerId));
    const txnRows = await db.select({ type: embeddedTransactions.type, amount: embeddedTransactions.amount }).from(embeddedTransactions).where(eq(embeddedTransactions.developerId, developerId));

    const totalWallets = walletRows.length;
    const activeWallets = walletRows.filter((w) => w.status === 'active').length;
    const totalFloat = walletRows.reduce((s, w) => s + w.balance, 0);
    const totalTransactions = txnRows.length;
    const totalCredited = txnRows.filter((t) => t.type === 'credit' || t.type === 'transfer_in').reduce((s, t) => s + t.amount, 0);
    const totalDebited = txnRows.filter((t) => t.type === 'debit' || t.type === 'transfer_out').reduce((s, t) => s + t.amount, 0);

    return { totalWallets, activeWallets, totalFloat, totalTransactions, totalCredited, totalDebited, currency: 'NGN' };
}
