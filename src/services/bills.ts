/**
 * Bill Payments Service
 *
 * Biller catalog, customer validation, bill payment processing,
 * saved billers, and scheduled payments.
 * Integrates with wallet (debit) + history (receipt) + notifications.
 */

import { eq, and, desc, like, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  billers,
  savedBillers,
  billPayments,
  scheduledPayments,
  wallets,
  walletTransactions,
  ledgerEntries,
  type Biller,
} from '../db';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// SEED DATA — Nigerian Biller Catalog
// =============================================================================

const BILLER_SEED: Omit<Biller, 'createdAt'>[] = [
  // Airtime
  { id: 'BLR_MTN_AIR', slug: 'mtn-airtime', name: 'MTN Airtime', category: 'airtime', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[10000,20000,50000,100000,200000,500000]', minAmount: 5000, maxAmount: 5000000, currency: 'NGN', active: true },
  { id: 'BLR_GLO_AIR', slug: 'glo-airtime', name: 'Glo Airtime', category: 'airtime', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[10000,20000,50000,100000,200000,500000]', minAmount: 5000, maxAmount: 5000000, currency: 'NGN', active: true },
  { id: 'BLR_9MOB_AIR', slug: '9mobile-airtime', name: '9mobile Airtime', category: 'airtime', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[10000,20000,50000,100000,200000,500000]', minAmount: 5000, maxAmount: 5000000, currency: 'NGN', active: true },
  { id: 'BLR_AIRTEL_AIR', slug: 'airtel-airtime', name: 'Airtel Airtime', category: 'airtime', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[10000,20000,50000,100000,200000,500000]', minAmount: 5000, maxAmount: 5000000, currency: 'NGN', active: true },

  // Data
  { id: 'BLR_MTN_DATA', slug: 'mtn-data', name: 'MTN Data', category: 'data', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[30000,50000,100000,200000,300000,500000]', minAmount: 30000, maxAmount: 5000000, currency: 'NGN', active: true },
  { id: 'BLR_GLO_DATA', slug: 'glo-data', name: 'Glo Data', category: 'data', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[20000,50000,100000,200000,500000]', minAmount: 20000, maxAmount: 5000000, currency: 'NGN', active: true },
  { id: 'BLR_AIRTEL_DATA', slug: 'airtel-data', name: 'Airtel Data', category: 'data', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: '[30000,50000,100000,200000,500000]', minAmount: 30000, maxAmount: 5000000, currency: 'NGN', active: true },

  // Electricity
  { id: 'BLR_EKEDC', slug: 'ekedc-prepaid', name: 'EKEDC (Eko Electricity)', category: 'electricity', country: 'NG', logoUrl: null, customerIdLabel: 'Meter Number', customerIdPattern: '^[0-9]{11,13}$', fixedAmounts: null, minAmount: 100000, maxAmount: 50000000, currency: 'NGN', active: true },
  { id: 'BLR_IKEDC', slug: 'ikedc-prepaid', name: 'IKEDC (Ikeja Electricity)', category: 'electricity', country: 'NG', logoUrl: null, customerIdLabel: 'Meter Number', customerIdPattern: '^[0-9]{11,13}$', fixedAmounts: null, minAmount: 100000, maxAmount: 50000000, currency: 'NGN', active: true },
  { id: 'BLR_AEDC', slug: 'aedc-prepaid', name: 'AEDC (Abuja Electricity)', category: 'electricity', country: 'NG', logoUrl: null, customerIdLabel: 'Meter Number', customerIdPattern: '^[0-9]{11,13}$', fixedAmounts: null, minAmount: 100000, maxAmount: 50000000, currency: 'NGN', active: true },
  { id: 'BLR_PHED', slug: 'phed-prepaid', name: 'PHED (Port Harcourt)', category: 'electricity', country: 'NG', logoUrl: null, customerIdLabel: 'Meter Number', customerIdPattern: '^[0-9]{11,13}$', fixedAmounts: null, minAmount: 100000, maxAmount: 50000000, currency: 'NGN', active: true },

  // Water
  { id: 'BLR_LSWC', slug: 'lagos-water', name: 'Lagos Water Corporation', category: 'water', country: 'NG', logoUrl: null, customerIdLabel: 'Account Number', customerIdPattern: '^[A-Z0-9]{8,12}$', fixedAmounts: null, minAmount: 50000, maxAmount: 10000000, currency: 'NGN', active: true },

  // Cable TV
  { id: 'BLR_DSTV', slug: 'dstv', name: 'DStv', category: 'cable_tv', country: 'NG', logoUrl: null, customerIdLabel: 'Smartcard Number', customerIdPattern: '^[0-9]{10,11}$', fixedAmounts: '[210000,450000,750000,1290000,2100000]', minAmount: 210000, maxAmount: 2500000, currency: 'NGN', active: true },
  { id: 'BLR_GOTV', slug: 'gotv', name: 'GOtv', category: 'cable_tv', country: 'NG', logoUrl: null, customerIdLabel: 'Smartcard Number', customerIdPattern: '^[0-9]{10,11}$', fixedAmounts: '[130000,260000,370000,530000]', minAmount: 130000, maxAmount: 1000000, currency: 'NGN', active: true },
  { id: 'BLR_STARTIMES', slug: 'startimes', name: 'StarTimes', category: 'cable_tv', country: 'NG', logoUrl: null, customerIdLabel: 'Smartcard Number', customerIdPattern: '^[0-9]{10,12}$', fixedAmounts: '[90000,180000,280000,400000]', minAmount: 90000, maxAmount: 500000, currency: 'NGN', active: true },

  // Internet
  { id: 'BLR_SPECTRANET', slug: 'spectranet', name: 'Spectranet', category: 'internet', country: 'NG', logoUrl: null, customerIdLabel: 'Account ID', customerIdPattern: '^[A-Z0-9]{6,12}$', fixedAmounts: '[350000,500000,700000,1000000]', minAmount: 350000, maxAmount: 2000000, currency: 'NGN', active: true },
  { id: 'BLR_SMILE', slug: 'smile', name: 'Smile', category: 'internet', country: 'NG', logoUrl: null, customerIdLabel: 'Account ID', customerIdPattern: '^[A-Z0-9]{6,12}$', fixedAmounts: '[250000,350000,500000,800000]', minAmount: 250000, maxAmount: 2000000, currency: 'NGN', active: true },

  // Betting
  { id: 'BLR_BET9JA', slug: 'bet9ja', name: 'Bet9ja', category: 'betting', country: 'NG', logoUrl: null, customerIdLabel: 'User ID', customerIdPattern: '^[A-Z0-9]{4,12}$', fixedAmounts: null, minAmount: 10000, maxAmount: 10000000, currency: 'NGN', active: true },
  { id: 'BLR_SPORTYBET', slug: 'sportybet', name: 'SportyBet', category: 'betting', country: 'NG', logoUrl: null, customerIdLabel: 'Phone Number', customerIdPattern: '^(0[789]0[0-9]{8})$', fixedAmounts: null, minAmount: 10000, maxAmount: 10000000, currency: 'NGN', active: true },

  // Government
  { id: 'BLR_FIRS', slug: 'firs', name: 'FIRS Tax Payment', category: 'government', country: 'NG', logoUrl: null, customerIdLabel: 'TIN', customerIdPattern: '^[0-9]{8,14}$', fixedAmounts: null, minAmount: 100000, maxAmount: 100000000, currency: 'NGN', active: true },

  // Insurance
  { id: 'BLR_LEADWAY', slug: 'leadway', name: 'Leadway Assurance', category: 'insurance', country: 'NG', logoUrl: null, customerIdLabel: 'Policy Number', customerIdPattern: '^[A-Z0-9]{6,16}$', fixedAmounts: null, minAmount: 100000, maxAmount: 50000000, currency: 'NGN', active: true },
];

// =============================================================================
// Seed function — idempotent, called at server start
// =============================================================================

export async function seedBillers(): Promise<void> {
  const db = getDatabase();
  const existing = await db.select({ id: billers.id }).from(billers);
  if (existing.length > 0) return; // already seeded

  const now = new Date();
  for (const biller of BILLER_SEED) {
    await db.insert(billers).values({ ...biller, createdAt: now });
  }
}

// =============================================================================
// Biller Catalog
// =============================================================================

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  airtime: { label: 'Airtime', icon: '📱' },
  data: { label: 'Data Bundles', icon: '📶' },
  electricity: { label: 'Electricity', icon: '⚡' },
  water: { label: 'Water', icon: '💧' },
  cable_tv: { label: 'Cable TV', icon: '📺' },
  internet: { label: 'Internet', icon: '🌐' },
  betting: { label: 'Betting', icon: '🎲' },
  government: { label: 'Government', icon: '🏛️' },
  insurance: { label: 'Insurance', icon: '🛡️' },
};

export async function getCategories(country?: string) {
  const db = getDatabase();
  const rows = await db
    .select({ category: billers.category })
    .from(billers)
    .where(
      and(
        eq(billers.active, true),
        country ? eq(billers.country, country) : undefined,
      ),
    )
    .groupBy(billers.category);

  return rows.map((r) => ({
    id: r.category,
    ...(CATEGORY_META[r.category] || { label: r.category, icon: '📋' }),
  }));
}

export async function getBillers(opts: { category?: string; country?: string; search?: string }) {
  const db = getDatabase();

  const conditions = [eq(billers.active, true)];
  if (opts.category) conditions.push(eq(billers.category, opts.category as any));
  if (opts.country) conditions.push(eq(billers.country, opts.country));
  if (opts.search) conditions.push(like(billers.name, `%${opts.search}%`));

  return db
    .select()
    .from(billers)
    .where(and(...conditions))
    .orderBy(billers.name);
}

export async function getBiller(billerId: string) {
  const db = getDatabase();
  const [row] = await db.select().from(billers).where(eq(billers.id, billerId)).limit(1);
  return row ?? null;
}

// =============================================================================
// Customer Validation (simulated aggregator)
// =============================================================================

export async function validateCustomer(billerId: string, customerId: string) {
  const biller = await getBiller(billerId);
  if (!biller) return { valid: false, error: 'Biller not found' };

  if (biller.customerIdPattern) {
    const re = new RegExp(biller.customerIdPattern);
    if (!re.test(customerId)) {
      return { valid: false, error: `Invalid ${biller.customerIdLabel}` };
    }
  }

  // Simulated aggregator response — in production, call VTPass/Quickteller
  const customerName = simulateCustomerLookup(biller, customerId);

  return {
    valid: true,
    customerName,
    customerId,
    billerName: biller.name,
    minAmount: biller.minAmount,
    maxAmount: biller.maxAmount,
    fixedAmounts: biller.fixedAmounts ? JSON.parse(biller.fixedAmounts) : null,
  };
}

function simulateCustomerLookup(biller: Biller, customerId: string): string {
  // Generate a plausible customer name for the demo
  const names = ['Adebayo O.', 'Chioma N.', 'Emeka I.', 'Fatima M.', 'Kwame A.'];
  const idx = customerId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % names.length;
  return names[idx];
}

// =============================================================================
// Pay Bill
// =============================================================================

export async function payBill(
  userId: string,
  opts: {
    billerId: string;
    customerId: string;
    amount: number;
    currency?: string;
    saveAsBiller?: boolean;
    alias?: string;
  },
) {
  const db = getDatabase();
  const biller = await getBiller(opts.billerId);
  if (!biller) throw { statusCode: 404, message: 'Biller not found' };
  if (!biller.active) throw { statusCode: 400, message: 'Biller is inactive' };

  const currency = opts.currency || biller.currency;
  const amount = opts.amount;

  // Validate amount range
  if (biller.minAmount && amount < biller.minAmount) {
    throw { statusCode: 400, message: `Minimum amount is ${biller.minAmount}` };
  }
  if (biller.maxAmount && amount > biller.maxAmount) {
    throw { statusCode: 400, message: `Maximum amount is ${biller.maxAmount}` };
  }

  // Debit user wallet
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
    .limit(1);

  if (!wallet) throw { statusCode: 400, message: 'Wallet not found for currency' };
  if (wallet.balance < amount) throw { statusCode: 400, message: 'Insufficient balance' };

  const now = new Date();
  const paymentId = `BPAY_${nanoid(16)}`;
  const txRef = `WTX_${nanoid(16)}`;
  const providerRef = `VTP_${nanoid(12)}`;

  // Simulate electricity token for electricity billers
  const token = biller.category === 'electricity'
    ? Array.from({ length: 20 }, () => Math.floor(Math.random() * 10)).join('')
    : null;

  // --- Begin transactional block ---

  // 1. Debit wallet
  await db.update(wallets)
    .set({ balance: wallet.balance - amount, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // 2. Wallet transaction record
  await db.insert(walletTransactions).values({
    id: txRef,
    walletId: wallet.id,
    type: 'payment',
    amount: -amount,
    currency,
    description: `${biller.name} — ${opts.customerId}`,
    status: 'completed',
    reference: paymentId,
    metadata: JSON.stringify({ billerId: biller.id, customerId: opts.customerId }),
    createdAt: now,
  });

  // 3. Ledger entries (double-entry)
  const debitId = `LED_${nanoid(16)}`;
  const creditId = `LED_${nanoid(16)}`;
  await db.insert(ledgerEntries).values([
    { id: debitId, transactionId: txRef, walletId: wallet.id, entryType: 'debit', amount, balanceAfter: wallet.balance - amount, createdAt: now },
    { id: creditId, transactionId: txRef, walletId: wallet.id, entryType: 'credit', amount, balanceAfter: wallet.balance - amount, createdAt: now },
  ]);

  // 4. Cross-vertical receipt (get generated ID first)
  const receiptId = await createReceipt({
    userId,
    vertical: 'bill_payments',
    type: biller.category,
    amount,
    currency,
    description: `${biller.name} — ${opts.customerId}`,
    counterparty: biller.name,
    status: 'completed',
    sourceRef: paymentId,
    metadata: { token, providerRef },
  });

  // 5. Bill payment record
  await db.insert(billPayments).values({
    id: paymentId,
    userId,
    billerId: biller.id,
    customerId: opts.customerId,
    amount,
    currency,
    status: 'completed',
    providerRef,
    token,
    receiptId,
    metadata: JSON.stringify({ customerName: simulateCustomerLookup(biller, opts.customerId) }),
    createdAt: now,
  });

  // 6. Notification
  createNotification({
    userId,
    type: 'transactional',
    title: 'Bill Payment Successful',
    body: `${biller.name} payment of ${currency} ${(amount / 100).toLocaleString()} completed.`,
    deepLink: `apex://history/receipt/${receiptId}`,
    metadata: { sourceAppId: 'com.apex.billpayments' },
  });

  // 7. Optionally save biller
  if (opts.saveAsBiller) {
    const [existing] = await db
      .select()
      .from(savedBillers)
      .where(
        and(
          eq(savedBillers.userId, userId),
          eq(savedBillers.billerId, biller.id),
          eq(savedBillers.customerId, opts.customerId),
        ),
      )
      .limit(1);
    if (!existing) {
      await db.insert(savedBillers).values({
        id: `SB_${nanoid(16)}`,
        userId,
        billerId: biller.id,
        customerId: opts.customerId,
        alias: opts.alias || biller.name,
        createdAt: now,
      });
    }
  }

  return {
    paymentId,
    status: 'completed',
    providerRef,
    token,
    receiptId,
    amount,
    currency,
    billerName: biller.name,
    customerId: opts.customerId,
  };
}

// =============================================================================
// Saved Billers
// =============================================================================

export async function getSavedBillers(userId: string) {
  const db = getDatabase();
  const rows = await db
    .select({
      id: savedBillers.id,
      customerId: savedBillers.customerId,
      alias: savedBillers.alias,
      createdAt: savedBillers.createdAt,
      billerId: billers.id,
      billerName: billers.name,
      billerSlug: billers.slug,
      billerCategory: billers.category,
      billerCustomerIdLabel: billers.customerIdLabel,
    })
    .from(savedBillers)
    .innerJoin(billers, eq(savedBillers.billerId, billers.id))
    .where(eq(savedBillers.userId, userId))
    .orderBy(desc(savedBillers.createdAt));

  return rows;
}

export async function saveBiller(
  userId: string,
  opts: { billerId: string; customerId: string; alias?: string },
) {
  const db = getDatabase();
  const biller = await getBiller(opts.billerId);
  if (!biller) throw { statusCode: 404, message: 'Biller not found' };

  const [existing] = await db
    .select()
    .from(savedBillers)
    .where(
      and(
        eq(savedBillers.userId, userId),
        eq(savedBillers.billerId, opts.billerId),
        eq(savedBillers.customerId, opts.customerId),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const row = {
    id: `SB_${nanoid(16)}`,
    userId,
    billerId: opts.billerId,
    customerId: opts.customerId,
    alias: opts.alias || biller.name,
    createdAt: new Date(),
  };
  await db.insert(savedBillers).values(row);
  return row;
}

export async function deleteSavedBiller(userId: string, savedBillerId: string) {
  const db = getDatabase();
  await db
    .delete(savedBillers)
    .where(and(eq(savedBillers.id, savedBillerId), eq(savedBillers.userId, userId)));
  return { deleted: true };
}

// =============================================================================
// Scheduled Payments
// =============================================================================

export async function getScheduledPayments(userId: string) {
  const db = getDatabase();
  return db
    .select({
      id: scheduledPayments.id,
      customerId: scheduledPayments.customerId,
      amount: scheduledPayments.amount,
      currency: scheduledPayments.currency,
      frequency: scheduledPayments.frequency,
      nextRunAt: scheduledPayments.nextRunAt,
      active: scheduledPayments.active,
      lastRunAt: scheduledPayments.lastRunAt,
      createdAt: scheduledPayments.createdAt,
      billerId: billers.id,
      billerName: billers.name,
      billerCategory: billers.category,
    })
    .from(scheduledPayments)
    .innerJoin(billers, eq(scheduledPayments.billerId, billers.id))
    .where(and(eq(scheduledPayments.userId, userId), eq(scheduledPayments.active, true)))
    .orderBy(scheduledPayments.nextRunAt);
}

export async function schedulePayment(
  userId: string,
  opts: {
    billerId: string;
    customerId: string;
    amount: number;
    currency?: string;
    frequency: 'daily' | 'weekly' | 'monthly';
  },
) {
  const db = getDatabase();
  const biller = await getBiller(opts.billerId);
  if (!biller) throw { statusCode: 404, message: 'Biller not found' };

  const now = new Date();
  const nextRunAt = computeNextRun(opts.frequency, now);

  const row = {
    id: `SCHED_${nanoid(16)}`,
    userId,
    billerId: opts.billerId,
    customerId: opts.customerId,
    amount: opts.amount,
    currency: opts.currency || biller.currency,
    frequency: opts.frequency,
    nextRunAt,
    active: true,
    lastRunAt: null,
    createdAt: now,
  };
  await db.insert(scheduledPayments).values(row);
  return row;
}

export async function cancelScheduledPayment(userId: string, scheduledId: string) {
  const db = getDatabase();
  await db
    .update(scheduledPayments)
    .set({ active: false })
    .where(and(eq(scheduledPayments.id, scheduledId), eq(scheduledPayments.userId, userId)));
  return { cancelled: true };
}

function computeNextRun(frequency: string, from: Date): Date {
  const d = new Date(from);
  switch (frequency) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
  }
  return d;
}
