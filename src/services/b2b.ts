/**
 * B2B Service
 *
 * Developer-scoped wallet, transactions, and KYB for the B2B web portal.
 */

import { eq, desc, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, b2bWallets, b2bTransactions, b2bKybRecords, developers } from '../db';

// ─── Wallet ───────────────────────────────────────────────────────────────────

/** Returns existing wallet or creates a new one for the developer. */
export async function getOrCreateWallet(developerId: string, currency = 'NGN') {
    const db = getDatabase();

    const [existing] = await db
        .select()
        .from(b2bWallets)
        .where(and(eq(b2bWallets.developerId, developerId), eq(b2bWallets.currency, currency)))
        .limit(1);

    if (existing) return existing;

    const now = new Date();
    const wallet = {
        id: nanoid(),
        developerId,
        currency,
        balance: 0,
        availableBalance: 0,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
    };

    await db.insert(b2bWallets).values(wallet);
    return wallet;
}

export async function getWallet(developerId: string, currency = 'NGN') {
    return getOrCreateWallet(developerId, currency);
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function getTransactions(
    developerId: string,
    params: { limit?: number; offset?: number; currency?: string } = {},
) {
    const db = getDatabase();
    const { limit = 20, offset = 0, currency } = params;

    const conditions = [eq(b2bTransactions.developerId, developerId)];
    if (currency) conditions.push(eq(b2bTransactions.currency, currency));

    const rows = await db
        .select()
        .from(b2bTransactions)
        .where(and(...conditions))
        .orderBy(desc(b2bTransactions.createdAt))
        .limit(limit)
        .offset(offset);

    return rows;
}

export async function createTransaction(
    developerId: string,
    params: {
        type: 'fund' | 'withdraw' | 'transfer' | 'fee' | 'refund';
        amount: number;
        currency: string;
        description?: string;
    },
) {
    const db = getDatabase();
    const wallet = await getOrCreateWallet(developerId, params.currency);
    const now = new Date();

    const txn = {
        id: nanoid(),
        walletId: wallet.id,
        developerId,
        type: params.type,
        amount: params.amount,
        fee: 0,
        currency: params.currency,
        status: 'completed' as const,
        description: params.description ?? null,
        reference: `B2B-${nanoid(12)}`,
        metadata: null,
        createdAt: now,
    };

    const balanceDelta = params.type === 'fund' || params.type === 'refund' ? params.amount : -params.amount;

    await db.insert(b2bTransactions).values(txn);
    await db
        .update(b2bWallets)
        .set({
            balance: wallet.balance + balanceDelta,
            availableBalance: wallet.availableBalance + balanceDelta,
            updatedAt: now,
        })
        .where(eq(b2bWallets.id, wallet.id));

    return { ...txn, balanceAfter: wallet.balance + balanceDelta };
}

// ─── KYB ──────────────────────────────────────────────────────────────────────

export async function getKybStatus(developerId: string) {
    const db = getDatabase();

    const [record] = await db
        .select()
        .from(b2bKybRecords)
        .where(eq(b2bKybRecords.developerId, developerId))
        .orderBy(desc(b2bKybRecords.createdAt))
        .limit(1);

    if (!record) {
        return { status: 'not_submitted', tier: 0, record: null };
    }

    return { status: record.status, tier: record.tier, record };
}

export async function submitKyb(
    developerId: string,
    params: {
        businessName: string;
        registrationNumber?: string;
        taxId?: string;
        country?: string;
        businessType?: 'sole_proprietor' | 'llc' | 'plc' | 'ngo' | 'cooperative';
    },
) {
    const db = getDatabase();
    const now = new Date();

    // Check for existing pending/approved record
    const [existing] = await db
        .select()
        .from(b2bKybRecords)
        .where(and(eq(b2bKybRecords.developerId, developerId)))
        .orderBy(desc(b2bKybRecords.createdAt))
        .limit(1);

    if (existing && (existing.status === 'submitted' || existing.status === 'approved')) {
        throw new Error(`KYB already ${existing.status}`);
    }

    const record = {
        id: nanoid(),
        developerId,
        businessName: params.businessName,
        registrationNumber: params.registrationNumber ?? null,
        taxId: params.taxId ?? null,
        country: params.country ?? 'NG',
        businessType: params.businessType ?? null,
        status: 'submitted' as const,
        tier: 1,
        rejectionReason: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now,
    };

    await db.insert(b2bKybRecords).values(record);
    return record;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getDeveloperProfile(developerId: string) {
    const db = getDatabase();
    const [dev] = await db
        .select({
            id: developers.id,
            email: developers.email,
            name: developers.name,
            organization: developers.organization,
            role: developers.role,
            createdAt: developers.createdAt,
        })
        .from(developers)
        .where(eq(developers.id, developerId))
        .limit(1);

    if (!dev) throw new Error('Developer not found');
    return dev;
}
