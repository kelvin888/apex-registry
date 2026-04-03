/**
 * Credit Service — mKudi Credit Engine
 *
 * Credit scoring, loan origination, disbursement (into wallet), repayment.
 * All amounts in minor units.
 */

import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  creditScores,
  loanOffers,
  loans,
  loanRepayments,
  wallets,
  walletTransactions,
  ledgerEntries,
  users,
} from '../db';
import { createReceipt } from './history';

// =============================================================================
// PRODUCT CONFIGS
// =============================================================================

interface ProductConfig {
  minAmount: number;
  maxAmount: number;
  maxTenorDays: number;
  interestRate: number; // per-tenor flat rate
  feeRate: number;      // origination fee %
  requiresBusiness: boolean;
}

const PRODUCT_CONFIGS: Record<string, ProductConfig> = {
  nano_loan: {
    minAmount: 100_000,      // ₦1,000
    maxAmount: 5_000_000,    // ₦50,000
    maxTenorDays: 30,
    interestRate: 0.05,
    feeRate: 0.01,
    requiresBusiness: false,
  },
  working_capital: {
    minAmount: 5_000_000,    // ₦50,000
    maxAmount: 500_000_000,  // ₦5,000,000
    maxTenorDays: 365,
    interestRate: 0.12,
    feeRate: 0.015,
    requiresBusiness: true,
  },
  invoice_financing: {
    minAmount: 10_000_000,   // ₦100,000
    maxAmount: 500_000_000,
    maxTenorDays: 90,
    interestRate: 0.08,
    feeRate: 0.02,
    requiresBusiness: true,
  },
  merchant_advance: {
    minAmount: 2_000_000,    // ₦20,000
    maxAmount: 100_000_000,  // ₦1,000,000
    maxTenorDays: 180,
    interestRate: 0.10,
    feeRate: 0.015,
    requiresBusiness: false,
  },
};

// =============================================================================
// CREDIT SCORING
// =============================================================================

/**
 * Calculate and cache a credit score for the user.
 * Scoring factors: wallet activity, KYC level, account age, repayment history.
 */
export async function getCreditScore(userId: string) {
  const db = getDatabase();

  // Check cached score (valid for 24h)
  const cached = await db
    .select()
    .from(creditScores)
    .where(eq(creditScores.userId, userId))
    .get();

  const oneDayAgo = new Date(Date.now() - 86_400_000);
  if (cached && cached.updatedAt > oneDayAgo) {
    return {
      score: cached.score,
      band: cached.band,
      maxEligibleAmount: cached.maxEligibleAmount,
      currency: cached.currency,
      factors: JSON.parse(cached.factors),
      lastUpdated: cached.updatedAt.getTime(),
    };
  }

  // Calculate score from available signals
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

  const factors: Array<{ name: string; impact: string; description: string }> = [];
  let score = 300; // base score

  // Factor 1: KYC level
  if (user.kycLevel === 'enhanced') {
    score += 200;
    factors.push({ name: 'kyc_level', impact: 'positive', description: 'Enhanced KYC verified' });
  } else if (user.kycLevel === 'full') {
    score += 150;
    factors.push({ name: 'kyc_level', impact: 'positive', description: 'Full KYC verified' });
  } else if (user.kycLevel === 'basic') {
    score += 50;
    factors.push({ name: 'kyc_level', impact: 'neutral', description: 'Basic KYC only' });
  } else {
    factors.push({ name: 'kyc_level', impact: 'negative', description: 'No KYC verification' });
  }

  // Factor 2: Account age
  const accountAgeDays = (Date.now() - user.createdAt.getTime()) / 86_400_000;
  if (accountAgeDays > 180) {
    score += 150;
    factors.push({ name: 'account_age', impact: 'positive', description: 'Account older than 6 months' });
  } else if (accountAgeDays > 90) {
    score += 100;
    factors.push({ name: 'account_age', impact: 'positive', description: 'Account older than 3 months' });
  } else {
    factors.push({ name: 'account_age', impact: 'negative', description: 'Account is new' });
  }

  // Factor 3: Wallet activity (check if user has any wallet with balance)
  const wallet = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.status, 'active')))
    .get();

  if (wallet && wallet.balance > 0) {
    score += 100;
    factors.push({ name: 'wallet_activity', impact: 'positive', description: 'Active wallet with balance' });
  } else if (wallet) {
    score += 30;
    factors.push({ name: 'wallet_activity', impact: 'neutral', description: 'Wallet created but low activity' });
  } else {
    factors.push({ name: 'wallet_activity', impact: 'negative', description: 'No wallet activity' });
  }

  // Factor 4: Repayment history
  const previousLoans = await db
    .select()
    .from(loans)
    .where(eq(loans.userId, userId))
    .all();

  const repaid = previousLoans.filter((l) => l.status === 'repaid').length;
  const defaulted = previousLoans.filter((l) => l.status === 'defaulted').length;

  if (defaulted > 0) {
    score -= 200;
    factors.push({ name: 'repayment_history', impact: 'negative', description: `${defaulted} defaulted loan(s)` });
  } else if (repaid > 0) {
    score += Math.min(repaid * 50, 200);
    factors.push({ name: 'repayment_history', impact: 'positive', description: `${repaid} loan(s) repaid on time` });
  } else {
    factors.push({ name: 'repayment_history', impact: 'neutral', description: 'No previous loans' });
  }

  // Clamp score
  score = Math.max(0, Math.min(1000, score));
  const band = score >= 750 ? 'excellent' : score >= 550 ? 'good' : score >= 350 ? 'fair' : 'poor';

  // Max eligible amount based on score
  let maxEligibleAmount = 0;
  if (score >= 350) maxEligibleAmount = 5_000_000;     // ₦50k
  if (score >= 550) maxEligibleAmount = 50_000_000;    // ₦500k
  if (score >= 750) maxEligibleAmount = 500_000_000;   // ₦5M

  const now = new Date();

  // Upsert cached score
  if (cached) {
    await db
      .update(creditScores)
      .set({ score, band, maxEligibleAmount, factors: JSON.stringify(factors), updatedAt: now })
      .where(eq(creditScores.id, cached.id));
  } else {
    await db.insert(creditScores).values({
      id: nanoid(),
      userId,
      score,
      band,
      maxEligibleAmount,
      currency: 'NGN',
      factors: JSON.stringify(factors),
      updatedAt: now,
    });
  }

  return {
    score,
    band,
    maxEligibleAmount,
    currency: 'NGN',
    factors,
    lastUpdated: now.getTime(),
  };
}

// =============================================================================
// REQUEST LOAN (generate offer)
// =============================================================================

export async function requestLoan(
  userId: string,
  params: {
    product: string;
    amount: number;
    currency: string;
    tenorDays: number;
    purpose?: string;
    invoiceRefs?: string[];
  },
) {
  const db = getDatabase();
  const config = PRODUCT_CONFIGS[params.product];
  if (!config) {
    throw Object.assign(new Error('Unknown loan product'), { statusCode: 400 });
  }

  // Product-specific validation
  if (params.amount < config.minAmount || params.amount > config.maxAmount) {
    return { offered: false, reason: `Amount must be between ${config.minAmount} and ${config.maxAmount}` };
  }
  if (params.tenorDays > config.maxTenorDays) {
    return { offered: false, reason: `Maximum tenor for ${params.product} is ${config.maxTenorDays} days` };
  }

  // Business requirement check
  if (config.requiresBusiness) {
    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!user?.isBusinessUser) {
      return { offered: false, reason: 'This product requires a business account' };
    }
  }

  // Credit score check
  const creditInfo = await getCreditScore(userId);
  if (params.amount > creditInfo.maxEligibleAmount) {
    return { offered: false, reason: `Amount exceeds eligible limit of ${creditInfo.maxEligibleAmount}` };
  }

  // Check for existing active loans (limit concurrent loans)
  const activeLoans = await db
    .select()
    .from(loans)
    .where(and(eq(loans.userId, userId), eq(loans.status, 'active')))
    .all();

  if (activeLoans.length >= 3) {
    return { offered: false, reason: 'Maximum concurrent active loans reached' };
  }

  // Generate offer
  const fee = Math.round(params.amount * config.feeRate);
  const interest = Math.round(params.amount * config.interestRate);
  const totalRepayment = params.amount + interest + fee;
  const months = Math.max(Math.ceil(params.tenorDays / 30), 1);
  const monthlyRepayment = Math.round(totalRepayment / months);

  const now = new Date();
  const offerId = nanoid();

  await db.insert(loanOffers).values({
    id: offerId,
    userId,
    product: params.product as any,
    amount: params.amount,
    currency: params.currency.toUpperCase(),
    interestRate: config.interestRate,
    tenorDays: params.tenorDays,
    totalRepayment,
    monthlyRepayment,
    fee,
    purpose: params.purpose,
    status: 'pending',
    expiresAt: new Date(now.getTime() + 86_400_000), // 24h
    createdAt: now,
  });

  return {
    offered: true,
    offer: {
      offerId,
      product: params.product,
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      interestRate: config.interestRate,
      tenorDays: params.tenorDays,
      totalRepayment,
      monthlyRepayment,
      fee,
      expiresAt: now.getTime() + 86_400_000,
    },
  };
}

// =============================================================================
// ACCEPT LOAN — disburse into wallet
// =============================================================================

export async function acceptLoan(userId: string, params: { offerId: string }) {
  const db = getDatabase();

  const offer = await db
    .select()
    .from(loanOffers)
    .where(and(eq(loanOffers.id, params.offerId), eq(loanOffers.userId, userId)))
    .get();

  if (!offer) {
    throw Object.assign(new Error('Offer not found'), { statusCode: 404 });
  }
  if (offer.status !== 'pending') {
    throw Object.assign(new Error(`Offer is ${offer.status}`), { statusCode: 400 });
  }
  if (offer.expiresAt < new Date()) {
    await db.update(loanOffers).set({ status: 'expired' }).where(eq(loanOffers.id, offer.id));
    throw Object.assign(new Error('Offer has expired'), { statusCode: 400 });
  }

  // Get or create wallet for disbursement
  const wallet = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, offer.currency)))
    .get();

  if (!wallet || wallet.status !== 'active') {
    throw Object.assign(new Error('Active wallet required for disbursement'), { statusCode: 400 });
  }

  const now = new Date();
  const loanId = nanoid();
  const disbursementRef = `dsb_${nanoid(16)}`;
  const txnId = nanoid();

  // Mark offer as accepted
  await db.update(loanOffers).set({ status: 'accepted' }).where(eq(loanOffers.id, offer.id));

  // Create loan record
  await db.insert(loans).values({
    id: loanId,
    userId,
    offerId: offer.id,
    walletId: wallet.id,
    product: offer.product,
    amount: offer.amount,
    outstandingBalance: offer.totalRepayment,
    currency: offer.currency,
    interestRate: offer.interestRate,
    totalRepayment: offer.totalRepayment,
    fee: offer.fee,
    status: 'active',
    disbursementRef,
    disbursedAt: now,
    dueDate: new Date(now.getTime() + offer.tenorDays * 86_400_000),
    createdAt: now,
  });

  // Disburse into wallet — create wallet transaction + ledger entries
  const newBalance = wallet.balance + offer.amount;
  const newAvailable = wallet.availableBalance + offer.amount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'loan_disbursement',
    amount: offer.amount,
    fee: 0,
    currency: offer.currency,
    status: 'completed',
    description: `Loan disbursement — ${offer.product}`,
    reference: disbursementRef,
    metadata: JSON.stringify({ loanId, offerId: offer.id }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount: offer.amount, balanceAfter: newBalance, createdAt: now },
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount: offer.amount, balanceAfter: newBalance, createdAt: now },
  ]);

  await db
    .update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Create cross-vertical receipt for loan disbursement
  await createReceipt({
    userId,
    vertical: 'credit',
    type: 'loan_disbursement',
    amount: offer.amount,
    currency: offer.currency,
    description: `Loan disbursement — ${offer.product}`,
    status: 'completed',
    sourceRef: disbursementRef,
    metadata: { loanId, product: offer.product },
  });

  return {
    success: true,
    loanId,
    status: 'active' as const,
    disbursementRef,
  };
}

// =============================================================================
// LOAN STATUS
// =============================================================================

export async function getLoanStatus(userId: string, params: { loanId: string }) {
  const db = getDatabase();

  const loan = await db
    .select()
    .from(loans)
    .where(and(eq(loans.id, params.loanId), eq(loans.userId, userId)))
    .get();

  if (!loan) {
    throw Object.assign(new Error('Loan not found'), { statusCode: 404 });
  }

  const repayments = await db
    .select()
    .from(loanRepayments)
    .where(eq(loanRepayments.loanId, loan.id))
    .orderBy(desc(loanRepayments.createdAt))
    .all();

  return {
    loanId: loan.id,
    product: loan.product,
    amount: loan.amount,
    outstandingBalance: loan.outstandingBalance,
    currency: loan.currency,
    interestRate: loan.interestRate,
    status: loan.status,
    disbursedAt: loan.disbursedAt?.getTime() ?? 0,
    dueDate: loan.dueDate.getTime(),
    repayments: repayments.map((r) => ({
      amount: r.amount,
      date: r.createdAt.getTime(),
      type: r.type,
    })),
  };
}

// =============================================================================
// REPAY LOAN — debit wallet, reduce outstanding balance
// =============================================================================

export async function repayLoan(
  userId: string,
  params: { loanId: string; amount?: number },
) {
  const db = getDatabase();

  const loan = await db
    .select()
    .from(loans)
    .where(and(eq(loans.id, params.loanId), eq(loans.userId, userId)))
    .get();

  if (!loan) {
    throw Object.assign(new Error('Loan not found'), { statusCode: 404 });
  }
  if (loan.status !== 'active' && loan.status !== 'overdue') {
    throw Object.assign(new Error(`Loan is ${loan.status}, cannot repay`), { statusCode: 400 });
  }

  const repayAmount = params.amount
    ? Math.min(params.amount, loan.outstandingBalance)
    : loan.outstandingBalance;

  if (repayAmount <= 0) {
    throw Object.assign(new Error('Nothing to repay'), { statusCode: 400 });
  }

  // Check wallet balance
  const wallet = await db.select().from(wallets).where(eq(wallets.id, loan.walletId)).get();
  if (!wallet || wallet.availableBalance < repayAmount) {
    throw Object.assign(new Error('Insufficient wallet balance for repayment'), { statusCode: 400 });
  }

  const now = new Date();
  const ref = `rpy_${nanoid(16)}`;
  const txnId = nanoid();

  const newBalance = wallet.balance - repayAmount;
  const newAvailable = wallet.availableBalance - repayAmount;
  const newOutstanding = loan.outstandingBalance - repayAmount;
  const newStatus = newOutstanding <= 0 ? 'repaid' : loan.status;

  // Wallet transaction for repayment
  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'loan_repayment',
    amount: repayAmount,
    fee: 0,
    currency: loan.currency,
    status: 'completed',
    description: `Loan repayment — ${loan.product}`,
    reference: ref,
    metadata: JSON.stringify({ loanId: loan.id }),
    createdAt: now,
  });

  // Ledger entries
  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount: repayAmount, balanceAfter: newBalance, createdAt: now },
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount: repayAmount, balanceAfter: newBalance, createdAt: now },
  ]);

  // Update wallet
  await db
    .update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Record repayment
  await db.insert(loanRepayments).values({
    id: nanoid(),
    loanId: loan.id,
    amount: repayAmount,
    type: 'manual',
    walletTransactionId: txnId,
    createdAt: now,
  });

  // Update loan
  await db
    .update(loans)
    .set({
      outstandingBalance: newOutstanding,
      status: newStatus as any,
      ...(newStatus === 'repaid' ? { closedAt: now } : {}),
    })
    .where(eq(loans.id, loan.id));

  // Create cross-vertical receipt for loan repayment
  await createReceipt({
    userId,
    vertical: 'credit',
    type: 'loan_repayment',
    amount: repayAmount,
    currency: loan.currency,
    description: `Loan repayment — ${loan.product}`,
    status: 'completed',
    sourceRef: ref,
    metadata: { loanId: loan.id, remainingBalance: Math.max(newOutstanding, 0) },
  });

  return {
    success: true,
    transactionRef: ref,
    remainingBalance: Math.max(newOutstanding, 0),
    status: newStatus,
  };
}
