/**
 * Wallet Service
 *
 * Double-entry ledger, multi-currency wallets, fund/withdraw/transfer/pay.
 * All amounts are in minor units (e.g. kobo for NGN, cents for KES).
 * KYC-tiered daily transaction limits.
 */

import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  wallets,
  walletTransactions,
  ledgerEntries,
  users,
  type Wallet,
  type WalletTransaction,
} from '../db';
import { createReceipt } from './history';

// =============================================================================
// KYC-Tiered Daily Limits (minor units)
// =============================================================================

const DAILY_LIMITS: Record<string, number> = {
  none: 0,
  basic: 5_000_000,       // ₦50,000
  full: 50_000_000,       // ₦500,000
  enhanced: 500_000_000,  // ₦5,000,000
};

// =============================================================================
// HELPERS
// =============================================================================

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function getDailySpend(db: ReturnType<typeof getDatabase>, walletId: string): Promise<number> {
  const start = todayStart();
  const [rows] = await db
    .select({ total: sql<number>`COALESCE(SUM(${walletTransactions.amount} + ${walletTransactions.fee}), 0)` })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.walletId, walletId),
        gte(walletTransactions.createdAt, start),
        eq(walletTransactions.status, 'completed'),
      ),
    )
    .limit(1);
  return rows?.total ?? 0;
}

async function getUserKycLevel(db: ReturnType<typeof getDatabase>, userId: string): Promise<string> {
  const [user] = await db.select({ kycLevel: users.kycLevel }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.kycLevel ?? 'none';
}

function generateRef(prefix: string): string {
  return `${prefix}_${nanoid(16)}`;
}

// =============================================================================
// WALLET MANAGEMENT
// =============================================================================

/**
 * Get or auto-create a wallet for a user + currency pair.
 */
export async function getOrCreateWallet(userId: string, currency = 'NGN'): Promise<Wallet> {
  const db = getDatabase();

  const [existing] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency.toUpperCase())))
    .limit(1);

  if (existing) return existing;

  const now = new Date();
  const wallet: typeof wallets.$inferInsert = {
    id: nanoid(),
    userId,
    currency: currency.toUpperCase(),
    balance: 0,
    availableBalance: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(wallets).values(wallet);
  return wallet as Wallet;
}

// =============================================================================
// BALANCE
// =============================================================================

export async function getBalance(userId: string, currency = 'NGN') {
  const wallet = await getOrCreateWallet(userId, currency);
  return {
    balance: wallet.balance,
    currency: wallet.currency,
    availableBalance: wallet.availableBalance,
    updatedAt: wallet.updatedAt.getTime(),
  };
}

// =============================================================================
// FUND WALLET
// =============================================================================

export async function fundWallet(
  userId: string,
  params: { amount: number; currency: string; source: string },
) {
  const db = getDatabase();
  const wallet = await getOrCreateWallet(userId, params.currency);

  if (wallet.status !== 'active') {
    throw Object.assign(new Error('Wallet is not active'), { statusCode: 403 });
  }

  // KYC limit check
  const kycLevel = await getUserKycLevel(db, userId);
  const limit = DAILY_LIMITS[kycLevel] ?? 0;
  if (limit === 0) {
    throw Object.assign(new Error('KYC verification required before funding'), { statusCode: 403 });
  }
  const dailySpend = await getDailySpend(db, wallet.id);
  if (dailySpend + params.amount > limit) {
    throw Object.assign(new Error(`Daily limit of ${limit} exceeded`), { statusCode: 403 });
  }

  const now = new Date();
  const ref = generateRef('fund');
  const txnId = nanoid();

  const newBalance = wallet.balance + params.amount;
  const newAvailable = wallet.availableBalance + params.amount;

  // Transaction
  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'fund',
    amount: params.amount,
    fee: 0,
    currency: wallet.currency,
    status: 'completed',
    description: `Wallet funding via ${params.source}`,
    reference: ref,
    metadata: JSON.stringify({ source: params.source }),
    createdAt: now,
  });

  // Double-entry: debit system (funding source), credit user wallet
  const entryBase = { createdAt: now, amount: params.amount };
  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, balanceAfter: newBalance, ...entryBase },
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, balanceAfter: newBalance, ...entryBase },
  ]);

  // Update wallet balance
  await db
    .update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Create cross-vertical receipt
  await createReceipt({
    userId,
    vertical: 'wallet',
    type: 'fund',
    amount: params.amount,
    currency: wallet.currency,
    description: `Wallet funding via ${params.source}`,
    status: 'completed',
    sourceRef: ref,
    metadata: { source: params.source },
  });

  return {
    success: true,
    transactionRef: ref,
    status: 'completed' as const,
  };
}

// =============================================================================
// TRANSFER
// =============================================================================

export async function initiateTransfer(
  userId: string,
  params: {
    amount: number;
    currency: string;
    recipientType: string;
    recipientId?: string;
    bankCode?: string;
    accountNumber?: string;
    narration?: string;
  },
) {
  const db = getDatabase();
  const wallet = await getOrCreateWallet(userId, params.currency);

  if (wallet.status !== 'active') {
    throw Object.assign(new Error('Wallet is not active'), { statusCode: 403 });
  }

  const fee = params.recipientType === 'bank' ? Math.min(params.amount * 0.005, 5000) : 0; // 0.5% capped at ₦50
  const total = params.amount + fee;

  if (wallet.availableBalance < total) {
    throw Object.assign(new Error('Insufficient balance'), { statusCode: 400 });
  }

  // KYC limit check
  const kycLevel = await getUserKycLevel(db, userId);
  const limit = DAILY_LIMITS[kycLevel] ?? 0;
  if (limit === 0) {
    throw Object.assign(new Error('KYC verification required'), { statusCode: 403 });
  }
  const dailySpend = await getDailySpend(db, wallet.id);
  if (dailySpend + total > limit) {
    throw Object.assign(new Error(`Daily limit of ${limit} exceeded`), { statusCode: 403 });
  }

  const now = new Date();
  const ref = generateRef('txfr');
  const txnId = nanoid();

  const newBalance = wallet.balance - total;
  const newAvailable = wallet.availableBalance - total;

  // Transaction record
  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'transfer',
    amount: params.amount,
    fee,
    currency: wallet.currency,
    status: 'completed',
    description: params.narration || `Transfer to ${params.recipientType}`,
    counterparty: params.recipientId || params.accountNumber,
    reference: ref,
    metadata: JSON.stringify({
      recipientType: params.recipientType,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
    }),
    createdAt: now,
  });

  // Ledger entries for sender
  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount: total, balanceAfter: newBalance, createdAt: now },
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount: total, balanceAfter: newBalance, createdAt: now },
  ]);

  // Update sender wallet
  await db
    .update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // If wallet-to-wallet, credit the recipient
  if (params.recipientType === 'wallet' && params.recipientId) {
    const recipientWallet = await getOrCreateWallet(params.recipientId, params.currency);
    const rNewBalance = recipientWallet.balance + params.amount;
    const rNewAvailable = recipientWallet.availableBalance + params.amount;

    await db.insert(ledgerEntries).values([
      { id: nanoid(), transactionId: txnId, walletId: recipientWallet.id, entryType: 'credit' as const, amount: params.amount, balanceAfter: rNewBalance, createdAt: now },
    ]);

    await db
      .update(wallets)
      .set({ balance: rNewBalance, availableBalance: rNewAvailable, updatedAt: now })
      .where(eq(wallets.id, recipientWallet.id));
  }

  // Create cross-vertical receipt
  await createReceipt({
    userId,
    vertical: 'wallet',
    type: 'transfer',
    amount: params.amount,
    currency: wallet.currency,
    description: params.narration || `Transfer to ${params.recipientType}`,
    counterparty: params.recipientId || params.accountNumber,
    status: 'completed',
    sourceRef: ref,
    metadata: { recipientType: params.recipientType, fee },
  });

  return {
    success: true,
    transactionRef: ref,
    status: 'completed' as const,
    fee,
  };
}

// =============================================================================
// PAYMENT (debit wallet for a mini-app purchase)
// =============================================================================

export async function processPayment(
  userId: string,
  params: { amount: number; currency: string; description?: string; merchantId?: string },
) {
  const db = getDatabase();
  const wallet = await getOrCreateWallet(userId, params.currency);

  if (wallet.status !== 'active') {
    throw Object.assign(new Error('Wallet is not active'), { statusCode: 403 });
  }

  if (wallet.availableBalance < params.amount) {
    throw Object.assign(new Error('Insufficient balance'), { statusCode: 400 });
  }

  const now = new Date();
  const ref = generateRef('pay');
  const txnId = nanoid();

  const newBalance = wallet.balance - params.amount;
  const newAvailable = wallet.availableBalance - params.amount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'payment',
    amount: params.amount,
    fee: 0,
    currency: wallet.currency,
    status: 'completed',
    description: params.description || 'Payment',
    counterparty: params.merchantId,
    reference: ref,
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount: params.amount, balanceAfter: newBalance, createdAt: now },
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount: params.amount, balanceAfter: newBalance, createdAt: now },
  ]);

  await db
    .update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Create cross-vertical receipt
  await createReceipt({
    userId,
    vertical: 'wallet',
    type: 'payment',
    amount: params.amount,
    currency: wallet.currency,
    description: params.description || 'Payment',
    counterparty: params.merchantId,
    status: 'completed',
    sourceRef: ref,
  });

  return {
    success: true,
    transactionRef: ref,
    status: 'completed' as const,
  };
}

// =============================================================================
// TRANSACTION HISTORY
// =============================================================================

export async function getTransactionHistory(
  userId: string,
  params: {
    limit?: number;
    offset?: number;
    type?: string;
    startDate?: number;
    endDate?: number;
    currency?: string;
  },
) {
  const db = getDatabase();
  const wallet = await getOrCreateWallet(userId, params.currency || 'NGN');

  const limit = Math.min(params.limit || 20, 100);
  const offset = params.offset || 0;

  // Build conditions
  const conditions = [eq(walletTransactions.walletId, wallet.id)];
  if (params.type) {
    conditions.push(eq(walletTransactions.type, params.type as any));
  }
  if (params.startDate) {
    conditions.push(gte(walletTransactions.createdAt, new Date(params.startDate)));
  }
  if (params.endDate) {
    conditions.push(lte(walletTransactions.createdAt, new Date(params.endDate)));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, [countResult]] = await Promise.all([
    db
      .select()
      .from(walletTransactions)
      .where(where)
      .orderBy(desc(walletTransactions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(walletTransactions)
      .where(where)
      .limit(1),
  ]);

  const total = countResult?.count ?? 0;

  const transactions = rows.map((row) => ({
    transactionRef: row.reference,
    type: row.type,
    amount: row.amount,
    fee: row.fee,
    currency: row.currency,
    status: row.status,
    description: row.description || '',
    counterparty: row.counterparty || undefined,
    timestamp: row.createdAt.getTime(),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }));

  return {
    transactions,
    total,
    hasMore: offset + limit < total,
  };
}
