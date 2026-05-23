/**
 * Transfers Service
 *
 * P2P wallet-to-wallet transfers, bank transfers, beneficiary management,
 * and QR-code transfer support.
 * Wraps wallet.initiateTransfer() with beneficiary tracking and richer records.
 */

import { eq, and, desc, like, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  beneficiaries,
  transfers,
  users,
  type Beneficiary,
  type Transfer,
} from '../db';
import { initiateTransfer as walletTransfer } from './wallet';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// Nigerian Banks Catalog
// =============================================================================

const NIGERIAN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '063', name: 'Diamond Bank' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '084', name: 'Enterprise Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '526', name: 'Kuda Microfinance Bank' },
  { code: '100', name: 'OPay' },
  { code: '101', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

// =============================================================================
// Bank Directory
// =============================================================================

export function getBanks(country = 'NG') {
  if (country === 'NG') return NIGERIAN_BANKS;
  return [];
}

// =============================================================================
// Recipient Lookup (simulated)
// =============================================================================

export async function lookupWalletRecipient(identifier: string) {
  const db = getDatabase();

  // Try phone or email lookup
  const [user] = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, phone: users.phone, email: users.email })
    .from(users)
    .where(
      identifier.includes('@')
        ? eq(users.email, identifier)
        : eq(users.phone, identifier),
    )
    .limit(1);

  if (!user) return null;

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Apex User';
  return {
    userId: user.id,
    name,
    phone: user.phone,
    email: user.email,
  };
}

export function lookupBankAccount(_bankCode: string, accountNumber: string) {
  // Simulated name enquiry — in production this calls NIBSS/NIP
  const names = [
    'Adebayo Ogundimu', 'Chidinma Okafor', 'Tunde Balogun', 'Ngozi Eze',
    'Emeka Nwosu', 'Funke Adeyemi', 'Ibrahim Musa', 'Aisha Mohammed',
  ];
  const hash = accountNumber.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    accountName: names[hash % names.length],
    bankCode: _bankCode,
    accountNumber,
  };
}

// =============================================================================
// Transfer Execution
// =============================================================================

export async function sendToWallet(
  userId: string,
  opts: {
    recipientId: string;
    amount: number;
    currency?: string;
    narration?: string;
    saveBeneficiary?: boolean;
  },
) {
  const currency = opts.currency || 'NGN';

  // Look up recipient name
  const db = getDatabase();
  const [recipient] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, opts.recipientId)).limit(1);
  if (!recipient) throw Object.assign(new Error('Recipient not found'), { statusCode: 404 });
  const recipientName = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || 'Apex User';

  // Execute through wallet service
  const result = await walletTransfer(userId, {
    amount: opts.amount,
    currency,
    recipientType: 'wallet',
    recipientId: opts.recipientId,
    narration: opts.narration,
  });

  const now = new Date();
  const transferId = `TXF_${nanoid(16)}`;

  // Create receipt
  const receiptId = await createReceipt({
    userId,
    vertical: 'transfers',
    type: 'wallet_transfer',
    amount: opts.amount,
    currency,
    description: opts.narration || `Transfer to ${recipientName}`,
    counterparty: recipientName,
    status: 'completed',
    sourceRef: result.transactionRef,
    metadata: { recipientId: opts.recipientId, recipientName },
  });

  // Transfer record
  await db.insert(transfers).values({
    id: transferId,
    senderId: userId,
    recipientType: 'wallet',
    recipientId: opts.recipientId,
    accountName: recipientName,
    amount: opts.amount,
    fee: 0,
    currency,
    narration: opts.narration || null,
    status: 'completed',
    transactionRef: result.transactionRef,
    receiptId,
    createdAt: now,
  });

  // Notify recipient
  createNotification({
    userId: opts.recipientId,
    type: 'transactional',
    title: 'Money Received!',
    body: `You received ${currency} ${(opts.amount / 100).toLocaleString()} from an Apex user.`,
    deepLink: `apex://wallet/history`,
    metadata: { sourceAppId: 'com.apex.transfers', transferId },
  });

  // Save as beneficiary
  if (opts.saveBeneficiary) {
    await upsertBeneficiary(userId, {
      type: 'wallet',
      accountId: opts.recipientId,
      accountName: recipientName,
    });
  }

  // Update beneficiary transfer count
  await updateBeneficiaryStats(userId, 'wallet', opts.recipientId);

  return {
    transferId,
    transactionRef: result.transactionRef,
    receiptId,
    status: 'completed',
    amount: opts.amount,
    fee: 0,
    currency,
    recipientName,
  };
}

export async function sendToBank(
  userId: string,
  opts: {
    bankCode: string;
    accountNumber: string;
    accountName: string;
    amount: number;
    currency?: string;
    narration?: string;
    saveBeneficiary?: boolean;
  },
) {
  const currency = opts.currency || 'NGN';
  const bank = NIGERIAN_BANKS.find((b) => b.code === opts.bankCode);
  const bankName = bank?.name || opts.bankCode;

  // Execute through wallet service
  const result = await walletTransfer(userId, {
    amount: opts.amount,
    currency,
    recipientType: 'bank',
    bankCode: opts.bankCode,
    accountNumber: opts.accountNumber,
    narration: opts.narration,
  });

  const now = new Date();
  const transferId = `TXF_${nanoid(16)}`;
  const db = getDatabase();

  // Create receipt
  const receiptId = await createReceipt({
    userId,
    vertical: 'transfers',
    type: 'bank_transfer',
    amount: opts.amount,
    currency,
    description: opts.narration || `Transfer to ${opts.accountName} (${bankName})`,
    counterparty: opts.accountName,
    status: 'completed',
    sourceRef: result.transactionRef,
    metadata: { bankCode: opts.bankCode, bankName, accountNumber: opts.accountNumber, fee: result.fee },
  });

  // Transfer record
  await db.insert(transfers).values({
    id: transferId,
    senderId: userId,
    recipientType: 'bank',
    recipientId: opts.accountNumber,
    bankCode: opts.bankCode,
    bankName,
    accountName: opts.accountName,
    amount: opts.amount,
    fee: result.fee,
    currency,
    narration: opts.narration || null,
    status: 'completed',
    transactionRef: result.transactionRef,
    receiptId,
    createdAt: now,
  });

  // Save as beneficiary
  if (opts.saveBeneficiary) {
    await upsertBeneficiary(userId, {
      type: 'bank',
      accountId: opts.accountNumber,
      bankCode: opts.bankCode,
      bankName,
      accountName: opts.accountName,
    });
  }

  await updateBeneficiaryStats(userId, 'bank', opts.accountNumber);

  return {
    transferId,
    transactionRef: result.transactionRef,
    receiptId,
    status: 'completed',
    amount: opts.amount,
    fee: result.fee,
    currency,
    recipientName: opts.accountName,
    bankName,
  };
}

// =============================================================================
// Transfer History
// =============================================================================

export async function getTransferHistory(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const db = getDatabase();
  const limit = opts.limit || 20;
  const offset = opts.offset || 0;

  const rows = await db
    .select()
    .from(transfers)
    .where(eq(transfers.senderId, userId))
    .orderBy(desc(transfers.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(transfers)
    .where(eq(transfers.senderId, userId));

  return { transfers: rows, total, hasMore: offset + limit < total };
}

// =============================================================================
// Beneficiaries
// =============================================================================

export async function getBeneficiaries(
  userId: string,
  opts: { type?: 'wallet' | 'bank'; search?: string } = {},
) {
  const db = getDatabase();
  const conditions = [eq(beneficiaries.userId, userId)];
  if (opts.type) conditions.push(eq(beneficiaries.type, opts.type as any));
  if (opts.search) conditions.push(like(beneficiaries.accountName, `%${opts.search}%`));

  return db
    .select()
    .from(beneficiaries)
    .where(and(...conditions))
    .orderBy(desc(beneficiaries.transferCount));
}

export async function upsertBeneficiary(
  userId: string,
  data: {
    type: 'wallet' | 'bank';
    accountId: string;
    accountName: string;
    bankCode?: string;
    bankName?: string;
    alias?: string;
  },
) {
  const db = getDatabase();
  const now = new Date();

  const [existing] = await db
    .select()
    .from(beneficiaries)
    .where(
      and(
        eq(beneficiaries.userId, userId),
        eq(beneficiaries.type, data.type as any),
        eq(beneficiaries.accountId, data.accountId),
      ),
    )
    .limit(1);

  if (existing) {
    await db.update(beneficiaries)
      .set({
        accountName: data.accountName,
        bankCode: data.bankCode || existing.bankCode,
        bankName: data.bankName || existing.bankName,
        alias: data.alias || existing.alias,
      })
      .where(eq(beneficiaries.id, existing.id));
    return existing.id;
  }

  const id = `BEN_${nanoid(16)}`;
  await db.insert(beneficiaries).values({
    id,
    userId,
    type: data.type,
    accountId: data.accountId,
    bankCode: data.bankCode || null,
    bankName: data.bankName || null,
    accountName: data.accountName,
    alias: data.alias || null,
    transferCount: 0,
    createdAt: now,
  });

  return id;
}

export async function deleteBeneficiary(userId: string, beneficiaryId: string) {
  const db = getDatabase();
  const [row] = await db
    .select()
    .from(beneficiaries)
    .where(and(eq(beneficiaries.id, beneficiaryId), eq(beneficiaries.userId, userId)))
    .limit(1);

  if (!row) throw Object.assign(new Error('Beneficiary not found'), { statusCode: 404 });

  await db.delete(beneficiaries).where(eq(beneficiaries.id, beneficiaryId));
  return { deleted: true };
}

async function updateBeneficiaryStats(userId: string, type: string, accountId: string) {
  const db = getDatabase();
  await db.update(beneficiaries)
    .set({
      transferCount: sql`${beneficiaries.transferCount} + 1`,
      lastTransferAt: new Date(),
    })
    .where(
      and(
        eq(beneficiaries.userId, userId),
        eq(beneficiaries.type, type as any),
        eq(beneficiaries.accountId, accountId),
      ),
    );
}

// =============================================================================
// QR Transfer
// =============================================================================

export function generateQRPayload(userId: string) {
  return {
    type: 'apex_transfer',
    userId,
    timestamp: Date.now(),
  };
}

export function parseQRPayload(payload: string) {
  try {
    const data = JSON.parse(payload);
    if (data.type !== 'apex_transfer' || !data.userId) return null;
    return { userId: data.userId };
  } catch {
    return null;
  }
}
