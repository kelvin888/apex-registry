/**
 * Insurance Service
 *
 * Plan catalog, enrollment, premium payments, and claims management.
 * Integrates with wallet (payment) + history (receipt) + notifications.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  insurancePlans,
  userInsurance,
  insuranceClaims,
  wallets,
  walletTransactions,
  ledgerEntries,
  type InsurancePlan,
} from '../db';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// SEED DATA — Nigerian Insurance Plans
// =============================================================================

const PLAN_SEED: Omit<InsurancePlan, 'createdAt'>[] = [
  // NHIA (Nigeria)
  { id: 'INS_NHIA_BASIC', name: 'NHIA Basic Plan', provider: 'NHIA', type: 'public', country: 'NG', coverageLevel: 'basic', premiumAmount: 150000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["General consultation","Basic labs","Generic drugs","Malaria treatment","Antenatal care"]', maxCoverage: 50000000, waitingPeriodDays: 30, active: true },
  { id: 'INS_NHIA_STD', name: 'NHIA Standard Plan', provider: 'NHIA', type: 'public', country: 'NG', coverageLevel: 'standard', premiumAmount: 350000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["General consultation","Specialist consultation","Full labs","Brand & generic drugs","Malaria treatment","Antenatal care","Minor surgery","Dental basic","Eye care"]', maxCoverage: 150000000, waitingPeriodDays: 30, active: true },

  // Private HMOs
  { id: 'INS_HYGEIA_BASIC', name: 'Hygeia HMO Basic', provider: 'Hygeia HMO', type: 'private', country: 'NG', coverageLevel: 'basic', premiumAmount: 250000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["General consultation","Basic labs","Generic drugs","Malaria treatment","Emergency care"]', maxCoverage: 100000000, waitingPeriodDays: 14, active: true },
  { id: 'INS_HYGEIA_PREM', name: 'Hygeia HMO Premium', provider: 'Hygeia HMO', type: 'private', country: 'NG', coverageLevel: 'premium', premiumAmount: 800000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["Unlimited GP consultation","Specialist consultation","Full labs & imaging","All drugs","Surgery","Dental & optical","Maternity","Mental health","Physiotherapy","Annual checkup"]', maxCoverage: 500000000, waitingPeriodDays: 0, active: true },
  { id: 'INS_LEADWAY_STD', name: 'Leadway Health Standard', provider: 'Leadway Health', type: 'private', country: 'NG', coverageLevel: 'standard', premiumAmount: 450000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["GP & specialist consultation","Full labs","Brand drugs","Surgery up to N2M","Dental","Optical","Maternity","Emergency evacuation"]', maxCoverage: 200000000, waitingPeriodDays: 14, active: true },
  { id: 'INS_AVON_BASIC', name: 'Avon HMO Lite', provider: 'Avon HMO', type: 'private', country: 'NG', coverageLevel: 'basic', premiumAmount: 200000, premiumFrequency: 'monthly', currency: 'NGN', benefits: '["GP consultation","Basic labs","Generic drugs","Malaria","Antenatal"]', maxCoverage: 80000000, waitingPeriodDays: 14, active: true },

  // NHIF (Kenya)
  { id: 'INS_NHIF_KE', name: 'NHIF Kenya Standard', provider: 'NHIF', type: 'public', country: 'KE', coverageLevel: 'standard', premiumAmount: 50000, premiumFrequency: 'monthly', currency: 'KES', benefits: '["Inpatient cover","Outpatient in selected facilities","Maternity","Surgical operations","Renal dialysis"]', maxCoverage: null, waitingPeriodDays: 60, active: true },
];

export function seedInsurancePlans(): void {
  const db = getDatabase();
  const now = new Date();

  for (const p of PLAN_SEED) {
    const existing = db.select({ id: insurancePlans.id }).from(insurancePlans)
      .where(eq(insurancePlans.id, p.id)).get();
    if (!existing) {
      db.insert(insurancePlans).values({ ...p, createdAt: now }).run();
    }
  }
}

// =============================================================================
// PLANS
// =============================================================================

export function getPlans(opts: { country?: string; type?: string; coverageLevel?: string }) {
  const db = getDatabase();
  const conditions: any[] = [eq(insurancePlans.active, true)];
  if (opts.country) conditions.push(eq(insurancePlans.country, opts.country));
  if (opts.type) conditions.push(eq(insurancePlans.type, opts.type as any));
  if (opts.coverageLevel) conditions.push(eq(insurancePlans.coverageLevel, opts.coverageLevel as any));

  return db.select().from(insurancePlans)
    .where(and(...conditions))
    .all();
}

export function getPlan(planId: string) {
  const db = getDatabase();
  return db.select().from(insurancePlans).where(eq(insurancePlans.id, planId)).get();
}

// =============================================================================
// ENROLLMENT
// =============================================================================

export async function enroll(userId: string, planId: string) {
  const db = getDatabase();
  const now = new Date();

  const plan = db.select().from(insurancePlans).where(eq(insurancePlans.id, planId)).get();
  if (!plan) throw new Error('Plan not found');

  // Check if already enrolled in active plan
  const existing = db.select().from(userInsurance)
    .where(and(eq(userInsurance.userId, userId), eq(userInsurance.status, 'active'))).get();
  if (existing) throw new Error('Already enrolled in an active plan');

  // Debit first premium
  const wallet = db.select().from(wallets).where(eq(wallets.userId, userId)).get();
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < plan.premiumAmount) throw new Error('Insufficient balance for premium');

  const enrollmentId = nanoid();
  const enrollmentNumber = `ENR-${nanoid(8).toUpperCase()}`;
  const txRef = `INS-${nanoid(12)}`;

  db.update(wallets).set({
    balance: wallet.balance - plan.premiumAmount,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id)).run();

  const txId = nanoid();
  db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: plan.premiumAmount,
    currency: plan.currency,
    description: `Insurance premium: ${plan.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ enrollmentId, planId }),
    createdAt: now,
  }).run();

  db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: plan.premiumAmount,
    balanceAfter: wallet.balance - plan.premiumAmount,
    createdAt: now,
  }).run();

  // Calculate next premium date
  const nextPremium = new Date(now);
  if (plan.premiumFrequency === 'monthly') nextPremium.setMonth(nextPremium.getMonth() + 1);
  else if (plan.premiumFrequency === 'quarterly') nextPremium.setMonth(nextPremium.getMonth() + 3);
  else nextPremium.setFullYear(nextPremium.getFullYear() + 1);

  db.insert(userInsurance).values({
    id: enrollmentId,
    userId,
    planId,
    enrollmentNumber,
    status: 'active',
    startDate: now,
    nextPremiumDate: nextPremium,
    totalPaid: plan.premiumAmount,
    createdAt: now,
    updatedAt: now,
  }).run();

  const receiptId = await createReceipt({
    userId,
    vertical: 'health',
    type: 'insurance_enrollment',
    amount: plan.premiumAmount,
    currency: plan.currency,
    description: `Insurance Enrollment: ${plan.name}`,
    counterparty: plan.provider,
    status: 'completed',
    sourceRef: txRef,
    metadata: { enrollmentId, planName: plan.name, enrollmentNumber },
  });

  await createNotification({
    userId,
    type: 'transactional',
    title: 'Insurance Enrollment Confirmed',
    body: `You are now enrolled in ${plan.name}. Enrollment #: ${enrollmentNumber}`,
    metadata: { enrollmentId, receiptId },
  });

  return { enrollmentId, enrollmentNumber, receiptId, premiumPaid: plan.premiumAmount };
}

export function getEnrollment(userId: string) {
  const db = getDatabase();
  const enrollment = db.select({
    enrollment: userInsurance,
    planName: insurancePlans.name,
    planProvider: insurancePlans.provider,
    planCoverageLevel: insurancePlans.coverageLevel,
    planPremiumAmount: insurancePlans.premiumAmount,
    planPremiumFrequency: insurancePlans.premiumFrequency,
    planBenefits: insurancePlans.benefits,
    planMaxCoverage: insurancePlans.maxCoverage,
    planCurrency: insurancePlans.currency,
  }).from(userInsurance)
    .innerJoin(insurancePlans, eq(userInsurance.planId, insurancePlans.id))
    .where(and(eq(userInsurance.userId, userId), eq(userInsurance.status, 'active')))
    .get();

  return enrollment || null;
}

export async function payPremium(userId: string) {
  const db = getDatabase();
  const now = new Date();

  const enrollment = db.select({
    enrollment: userInsurance,
    premiumAmount: insurancePlans.premiumAmount,
    premiumFrequency: insurancePlans.premiumFrequency,
    planName: insurancePlans.name,
    currency: insurancePlans.currency,
  }).from(userInsurance)
    .innerJoin(insurancePlans, eq(userInsurance.planId, insurancePlans.id))
    .where(and(eq(userInsurance.userId, userId), eq(userInsurance.status, 'active')))
    .get();

  if (!enrollment) throw new Error('No active enrollment');

  const amount = enrollment.premiumAmount;
  const wallet = db.select().from(wallets).where(eq(wallets.userId, userId)).get();
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < amount) throw new Error('Insufficient balance');

  const txRef = `INSPREM-${nanoid(12)}`;

  db.update(wallets).set({
    balance: wallet.balance - amount,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id)).run();

  const txId = nanoid();
  db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount,
    currency: enrollment.currency,
    description: `Insurance premium: ${enrollment.planName}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ enrollmentId: enrollment.enrollment.id }),
    createdAt: now,
  }).run();

  db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount,
    balanceAfter: wallet.balance - amount,
    createdAt: now,
  }).run();

  // Advance next premium date
  const nextPremium = new Date(now);
  if (enrollment.premiumFrequency === 'monthly') nextPremium.setMonth(nextPremium.getMonth() + 1);
  else if (enrollment.premiumFrequency === 'quarterly') nextPremium.setMonth(nextPremium.getMonth() + 3);
  else nextPremium.setFullYear(nextPremium.getFullYear() + 1);

  db.update(userInsurance).set({
    totalPaid: enrollment.enrollment.totalPaid + amount,
    nextPremiumDate: nextPremium,
    updatedAt: now,
  }).where(eq(userInsurance.id, enrollment.enrollment.id)).run();

  await createReceipt({
    userId,
    vertical: 'health',
    type: 'insurance_premium',
    amount,
    currency: enrollment.currency,
    description: `Insurance Premium: ${enrollment.planName}`,
    status: 'completed',
    sourceRef: txRef,
    metadata: { enrollmentId: enrollment.enrollment.id },
  });

  return { paid: amount, nextPremiumDate: nextPremium.getTime() };
}

export async function cancelEnrollment(userId: string) {
  const db = getDatabase();
  const enrollment = db.select().from(userInsurance)
    .where(and(eq(userInsurance.userId, userId), eq(userInsurance.status, 'active'))).get();
  if (!enrollment) throw new Error('No active enrollment');

  db.update(userInsurance).set({
    status: 'cancelled',
    updatedAt: new Date(),
  }).where(eq(userInsurance.id, enrollment.id)).run();

  await createNotification({
    userId,
    type: 'system',
    title: 'Insurance Cancelled',
    body: 'Your insurance enrollment has been cancelled.',
    metadata: { enrollmentId: enrollment.id },
  });

  return { cancelled: true };
}

// =============================================================================
// CLAIMS
// =============================================================================

export async function submitClaim(data: {
  userId: string;
  type: 'consultation' | 'pharmacy' | 'lab_test' | 'hospitalization' | 'other';
  description: string;
  amount: number;
  evidenceUrls?: string[];
  appointmentId?: string;
}) {
  const db = getDatabase();
  const now = new Date();

  const enrollment = db.select().from(userInsurance)
    .where(and(eq(userInsurance.userId, data.userId), eq(userInsurance.status, 'active'))).get();
  if (!enrollment) throw new Error('No active insurance enrollment');

  const claimId = nanoid();

  db.insert(insuranceClaims).values({
    id: claimId,
    enrollmentId: enrollment.id,
    userId: data.userId,
    type: data.type,
    description: data.description,
    amount: data.amount,
    currency: enrollment.id ? 'NGN' : 'NGN', // derive from enrollment
    status: 'submitted',
    evidenceUrls: data.evidenceUrls ? JSON.stringify(data.evidenceUrls) : null,
    appointmentId: data.appointmentId || null,
    submittedAt: now,
  }).run();

  await createNotification({
    userId: data.userId,
    type: 'system',
    title: 'Claim Submitted',
    body: `Your insurance claim for ${(data.amount / 100).toLocaleString()} NGN has been submitted for review.`,
    metadata: { claimId },
  });

  return { claimId };
}

export function getClaims(userId: string) {
  const db = getDatabase();
  return db.select().from(insuranceClaims)
    .where(eq(insuranceClaims.userId, userId))
    .orderBy(desc(insuranceClaims.submittedAt))
    .all();
}

export function getClaim(claimId: string) {
  const db = getDatabase();
  return db.select().from(insuranceClaims)
    .where(eq(insuranceClaims.id, claimId)).get();
}

/**
 * Process claim (admin/auto). Approves/rejects and disburses if approved.
 */
export async function processClaim(claimId: string, decision: 'approved' | 'rejected', reviewNotes?: string, approvedAmount?: number) {
  const db = getDatabase();
  const now = new Date();

  const claim = db.select().from(insuranceClaims)
    .where(eq(insuranceClaims.id, claimId)).get();
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'submitted' && claim.status !== 'under_review') {
    throw new Error('Claim already resolved');
  }

  const finalAmount = decision === 'approved' ? (approvedAmount || claim.amount) : 0;

  db.update(insuranceClaims).set({
    status: decision === 'approved' ? 'approved' : 'rejected',
    reviewNotes: reviewNotes || null,
    approvedAmount: finalAmount,
    resolvedAt: now,
  }).where(eq(insuranceClaims.id, claimId)).run();

  // If approved, credit wallet and update enrollment totals
  if (decision === 'approved' && finalAmount > 0) {
    const wallet = db.select().from(wallets).where(eq(wallets.userId, claim.userId)).get();
    if (wallet) {
      db.update(wallets).set({
        balance: wallet.balance + finalAmount,
        updatedAt: now,
      }).where(eq(wallets.id, wallet.id)).run();

      const txId = nanoid();
      db.insert(walletTransactions).values({
        id: txId,
        walletId: wallet.id,
        type: 'refund',
        amount: finalAmount,
        currency: claim.currency,
        description: `Insurance claim payout`,
        reference: `CLMPAY-${nanoid(12)}`,
        status: 'completed',
        metadata: JSON.stringify({ claimId }),
        createdAt: now,
      }).run();

      db.insert(ledgerEntries).values({
        id: nanoid(),
        transactionId: txId,
        walletId: wallet.id,
        entryType: 'credit',
        amount: finalAmount,
        balanceAfter: wallet.balance + finalAmount,
        createdAt: now,
      }).run();
    }

    // Update enrollment total claimed
    db.update(userInsurance).set({
      totalClaimed: sql`${userInsurance.totalClaimed} + ${finalAmount}`,
      updatedAt: now,
    }).where(eq(userInsurance.id, claim.enrollmentId)).run();
  }

  await createNotification({
    userId: claim.userId,
    type: decision === 'approved' ? 'transactional' : 'system',
    title: decision === 'approved' ? 'Claim Approved' : 'Claim Rejected',
    body: decision === 'approved'
      ? `Your claim has been approved. ${(finalAmount / 100).toLocaleString()} NGN credited to your wallet.`
      : `Your claim has been rejected.${reviewNotes ? ` Reason: ${reviewNotes}` : ''}`,
    metadata: { claimId },
  });

  return { status: decision, approvedAmount: finalAmount };
}
