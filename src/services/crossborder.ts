/**
 * Cross-border Payments Service
 *
 * Recipient management, FX rate lookup, and transfer initiation/tracking.
 */

import { eq, desc, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, crossborderRecipients, crossborderTransfers } from '../db';

// ─── FX Rates (static approximations — replace with live provider) ────────────

const FX_RATES: Record<string, Record<string, number>> = {
    NGN: { USD: 0.000625, GBP: 0.000500, EUR: 0.000580, KES: 0.081, GHS: 0.0082, ZAR: 0.011, XOF: 0.38, RWF: 0.82 },
    USD: { NGN: 1600, GBP: 0.80, EUR: 0.93, KES: 130, GHS: 13.2, ZAR: 18.2, XOF: 608, RWF: 1310 },
    GBP: { NGN: 2000, USD: 1.25, EUR: 1.16, KES: 162, GHS: 16.5, ZAR: 22.7, XOF: 760, RWF: 1637 },
    EUR: { NGN: 1724, USD: 1.07, GBP: 0.86, KES: 139, GHS: 14.2, ZAR: 19.6, XOF: 656, RWF: 1410 },
};

/** Returns rate from sourceCurrency → targetCurrency, or throws if unsupported */
function getRate(from: string, to: string): number {
    if (from === to) return 1;
    const rate = FX_RATES[from]?.[to];
    if (!rate) throw Object.assign(new Error(`Exchange rate ${from}→${to} not available`), { statusCode: 422 });
    return rate;
}

/** Supported destination countries with their currencies */
export const SUPPORTED_CORRIDORS = [
    { country: 'KE', name: 'Kenya', currency: 'KES', flag: '🇰🇪' },
    { country: 'GH', name: 'Ghana', currency: 'GHS', flag: '🇬🇭' },
    { country: 'ZA', name: 'South Africa', currency: 'ZAR', flag: '🇿🇦' },
    { country: 'SN', name: 'Senegal', currency: 'XOF', flag: '🇸🇳' },
    { country: 'CI', name: "Côte d'Ivoire", currency: 'XOF', flag: '🇨🇮' },
    { country: 'RW', name: 'Rwanda', currency: 'RWF', flag: '🇷🇼' },
    { country: 'GB', name: 'United Kingdom', currency: 'GBP', flag: '🇬🇧' },
    { country: 'US', name: 'United States', currency: 'USD', flag: '🇺🇸' },
    { country: 'EU', name: 'Euro Zone', currency: 'EUR', flag: '🇪🇺' },
];

// ─── FX Quote ─────────────────────────────────────────────────────────────────

export function getQuote(sendCurrency: string, receiveCurrency: string, sendAmount: number) {
    const rate = getRate(sendCurrency, receiveCurrency);
    const receiveAmount = Math.floor(sendAmount * rate);
    // Fee: 1.5% of send amount, min 50 NGN equivalent
    const feePct = 0.015;
    const fee = Math.max(Math.floor(sendAmount * feePct), 5000);
    return {
        sendAmount,
        sendCurrency,
        receiveAmount,
        receiveCurrency,
        exchangeRate: rate.toString(),
        fee,
        feeCurrency: sendCurrency,
        total: sendAmount + fee,
    };
}

// ─── Recipients ───────────────────────────────────────────────────────────────

export async function listRecipients(developerId: string) {
    const db = getDatabase();
    return db
        .select()
        .from(crossborderRecipients)
        .where(and(eq(crossborderRecipients.developerId, developerId), eq(crossborderRecipients.isActive, true)))
        .orderBy(desc(crossborderRecipients.createdAt));
}

export async function createRecipient(
    developerId: string,
    params: {
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
    },
) {
    const db = getDatabase();
    const now = new Date();
    const recipient = {
        id: nanoid(),
        developerId,
        alias: params.alias,
        fullName: params.fullName,
        country: params.country,
        currency: params.currency,
        type: params.type,
        accountNumber: params.accountNumber,
        bankName: params.bankName ?? null,
        bankCode: params.bankCode ?? null,
        routingNumber: params.routingNumber ?? null,
        swiftCode: params.swiftCode ?? null,
        ibanNumber: params.ibanNumber ?? null,
        mobileWalletProvider: params.mobileWalletProvider ?? null,
        mobileWalletNumber: params.mobileWalletNumber ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
    };
    await db.insert(crossborderRecipients).values(recipient);
    return recipient;
}

export async function deleteRecipient(developerId: string, recipientId: string) {
    const db = getDatabase();
    const [row] = await db
        .select()
        .from(crossborderRecipients)
        .where(and(eq(crossborderRecipients.id, recipientId), eq(crossborderRecipients.developerId, developerId)))
        .limit(1);
    if (!row) throw Object.assign(new Error('Recipient not found'), { statusCode: 404 });
    await db
        .update(crossborderRecipients)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(crossborderRecipients.id, recipientId));
}

// ─── Transfers ────────────────────────────────────────────────────────────────

export async function listTransfers(developerId: string, params: { status?: string } = {}) {
    const db = getDatabase();
    const conditions = [eq(crossborderTransfers.developerId, developerId)];
    if (params.status) conditions.push(eq(crossborderTransfers.status, params.status as any));
    return db
        .select()
        .from(crossborderTransfers)
        .where(and(...conditions))
        .orderBy(desc(crossborderTransfers.createdAt));
}

export async function initiateTransfer(
    developerId: string,
    params: {
        recipientId?: string;
        sendAmount: number;
        sendCurrency: string;
        receiveCurrency: string;
        recipientName: string;
        recipientCountry: string;
        recipientAccount: string;
        purpose: 'business_payment' | 'salary' | 'invoice' | 'supplier' | 'family_support' | 'other';
        narration?: string;
    },
) {
    const db = getDatabase();
    const quote = getQuote(params.sendCurrency, params.receiveCurrency, params.sendAmount);
    const now = new Date();

    const transfer = {
        id: nanoid(),
        developerId,
        recipientId: params.recipientId ?? null,
        reference: `XBR-${Date.now()}-${nanoid(6).toUpperCase()}`,
        sendAmount: params.sendAmount,
        sendCurrency: params.sendCurrency,
        receiveAmount: quote.receiveAmount,
        receiveCurrency: params.receiveCurrency,
        exchangeRate: quote.exchangeRate,
        fee: quote.fee,
        feeCurrency: quote.feeCurrency,
        recipientName: params.recipientName,
        recipientCountry: params.recipientCountry,
        recipientAccount: params.recipientAccount,
        purpose: params.purpose,
        narration: params.narration ?? null,
        status: 'processing' as const,
        failureReason: null,
        initiatedAt: now,
        completedAt: null,
        createdAt: now,
    };

    await db.insert(crossborderTransfers).values(transfer);
    return { ...transfer, quote };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getTransferSummary(developerId: string) {
    const db = getDatabase();
    const rows = await db
        .select({ status: crossborderTransfers.status, sendAmount: crossborderTransfers.sendAmount, sendCurrency: crossborderTransfers.sendCurrency })
        .from(crossborderTransfers)
        .where(eq(crossborderTransfers.developerId, developerId));

    const total = rows.length;
    const completed = rows.filter((r) => r.status === 'completed').length;
    const pending = rows.filter((r) => r.status === 'pending' || r.status === 'processing').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    const totalSent = rows
        .filter((r) => r.status === 'completed')
        .reduce((s, r) => s + r.sendAmount, 0);

    return { total, completed, pending, failed, totalSent, sendCurrency: 'NGN' };
}
