/**
 * Identity Service
 *
 * Manages end-user KYC/KYB verification flows
 */

import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as crypto from 'node:crypto';
import {
  getDatabase,
  users,
  kycRecords,
  kybRecords,
  type User,
  type NewUser,
  type KycRecord,
  type KybRecord,
} from '../db';

// =============================================================================
// USER MANAGEMENT
// =============================================================================

/**
 * Get or create a user by phone number.
 * Used by the host app when a user first authenticates.
 */
export async function getOrCreateUser(phone: string, country: string): Promise<User> {
  const db = getDatabase();

  const existing = await db.select().from(users).where(eq(users.phone, phone)).get();
  if (existing) return existing;

  const now = new Date();
  const user: NewUser = {
    id: nanoid(),
    phone,
    country: country.toUpperCase(),
    kycLevel: 'none',
    kybLevel: 'none',
    isBusinessUser: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(users).values(user);
  return user as User;
}

export async function getUserById(id: string): Promise<User | null> {
  const db = getDatabase();
  return (await db.select().from(users).where(eq(users.id, id)).get()) || null;
}

export async function updateUserProfile(
  id: string,
  input: { firstName?: string; lastName?: string; email?: string; avatar?: string; country?: string }
): Promise<User> {
  const db = getDatabase();
  const updated = await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();

  if (!updated.length) throw new Error('User not found');
  return updated[0];
}

// =============================================================================
// KYC
// =============================================================================

/**
 * Get current KYC status for a user (latest record or synthesized "none").
 */
export async function getKYCStatus(userId: string): Promise<{
  level: string;
  status: string;
  verifiedFields: string[];
  nextStep?: string;
}> {
  const db = getDatabase();
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('User not found');

  // Get latest KYC record
  const latest = await db
    .select()
    .from(kycRecords)
    .where(eq(kycRecords.userId, userId))
    .orderBy(desc(kycRecords.submittedAt))
    .get();

  if (!latest) {
    return {
      level: user.kycLevel,
      status: 'not_started',
      verifiedFields: [],
      nextStep: getNextKYCStep(user.kycLevel, user.country),
    };
  }

  return {
    level: user.kycLevel,
    status: latest.status,
    verifiedFields: latest.verifiedFields ? JSON.parse(latest.verifiedFields) : [],
    nextStep: latest.status === 'approved' ? undefined : latest.nextStep ?? undefined,
  };
}

/**
 * Submit a KYC verification request.
 */
export async function submitKYC(
  userId: string,
  params: {
    targetLevel: string;
    country?: string;
    nationalIdType?: string;
    nationalIdValue?: string;
    documentType?: string;
  }
): Promise<{ initiated: boolean; status: string; estimatedHours: number }> {
  const db = getDatabase();
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('User not found');

  const country = (params.country ?? user.country).toUpperCase();

  // Check for pending submission
  const pending = await db
    .select()
    .from(kycRecords)
    .where(and(eq(kycRecords.userId, userId), eq(kycRecords.status, 'pending')))
    .get();

  if (pending) {
    return { initiated: false, status: 'pending', estimatedHours: 24 };
  }

  const now = new Date();
  const record: typeof kycRecords.$inferInsert = {
    id: nanoid(),
    userId,
    targetLevel: params.targetLevel as 'basic' | 'full' | 'enhanced',
    status: 'pending',
    country,
    nationalIdType: params.nationalIdType,
    nationalIdHash: params.nationalIdValue
      ? crypto.createHash('sha256').update(params.nationalIdValue).digest('hex')
      : undefined,
    documentType: params.documentType,
    verifiedFields: '[]',
    nextStep: getNextKYCStep('none', country),
    submittedAt: now,
  };

  await db.insert(kycRecords).values(record);

  return { initiated: true, status: 'pending', estimatedHours: 24 };
}

// =============================================================================
// KYB
// =============================================================================

export async function getKYBStatus(userId: string): Promise<{
  level: string;
  status: string;
  businessName?: string;
  registrationNumber?: string;
  verifiedFields: string[];
  nextStep?: string;
}> {
  const db = getDatabase();
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('User not found');

  const latest = await db
    .select()
    .from(kybRecords)
    .where(eq(kybRecords.userId, userId))
    .orderBy(desc(kybRecords.submittedAt))
    .get();

  if (!latest) {
    return {
      level: user.kybLevel,
      status: 'not_started',
      verifiedFields: [],
      nextStep: 'submit_business_reg',
    };
  }

  return {
    level: user.kybLevel,
    status: latest.status,
    businessName: latest.businessName ?? undefined,
    registrationNumber: latest.registrationNumber ?? undefined,
    verifiedFields: latest.verifiedFields ? JSON.parse(latest.verifiedFields) : [],
    nextStep: latest.status === 'approved' ? undefined : latest.nextStep ?? undefined,
  };
}

export async function submitKYB(
  userId: string,
  params: {
    targetLevel: string;
    country?: string;
    businessType?: string;
    businessName?: string;
    registrationNumber?: string;
    taxId?: string;
  }
): Promise<{ initiated: boolean; status: string; estimatedHours: number }> {
  const db = getDatabase();
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('User not found');

  const country = (params.country ?? user.country).toUpperCase();

  const pending = await db
    .select()
    .from(kybRecords)
    .where(and(eq(kybRecords.userId, userId), eq(kybRecords.status, 'pending')))
    .get();

  if (pending) {
    return { initiated: false, status: 'pending', estimatedHours: 48 };
  }

  const now = new Date();
  const record: typeof kybRecords.$inferInsert = {
    id: nanoid(),
    userId,
    targetLevel: params.targetLevel as 'registered' | 'verified' | 'trusted',
    status: 'pending',
    country,
    businessName: params.businessName,
    businessType: params.businessType as any,
    registrationNumber: params.registrationNumber,
    taxId: params.taxId,
    verifiedFields: '[]',
    nextStep: 'submit_business_reg',
    submittedAt: now,
  };

  await db.insert(kybRecords).values(record);

  // Mark user as business user
  if (!user.isBusinessUser) {
    await db.update(users).set({ isBusinessUser: true, updatedAt: now }).where(eq(users.id, userId));
  }

  return { initiated: true, status: 'pending', estimatedHours: 48 };
}

// =============================================================================
// ADMIN REVIEW
// =============================================================================

export async function reviewKYC(
  recordId: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  reason?: string
): Promise<KycRecord> {
  const db = getDatabase();
  const now = new Date();

  const record = await db.select().from(kycRecords).where(eq(kycRecords.id, recordId)).get();
  if (!record) throw new Error('KYC record not found');
  if (record.status !== 'pending' && record.status !== 'under_review') {
    throw new Error(`Cannot review record in status: ${record.status}`);
  }

  const verifiedFields =
    decision === 'approved'
      ? JSON.stringify(getVerifiedFieldsForLevel(record.targetLevel))
      : record.verifiedFields;

  const updated = await db
    .update(kycRecords)
    .set({
      status: decision,
      verifiedFields,
      rejectionReason: decision === 'rejected' ? reason : undefined,
      reviewerId,
      reviewedAt: now,
      nextStep: decision === 'approved' ? undefined : record.nextStep,
    })
    .where(eq(kycRecords.id, recordId))
    .returning();

  // If approved, update user's KYC level
  if (decision === 'approved') {
    await db
      .update(users)
      .set({ kycLevel: record.targetLevel, updatedAt: now })
      .where(eq(users.id, record.userId));
  }

  return updated[0];
}

export async function reviewKYB(
  recordId: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  reason?: string
): Promise<KybRecord> {
  const db = getDatabase();
  const now = new Date();

  const record = await db.select().from(kybRecords).where(eq(kybRecords.id, recordId)).get();
  if (!record) throw new Error('KYB record not found');
  if (record.status !== 'pending' && record.status !== 'under_review') {
    throw new Error(`Cannot review record in status: ${record.status}`);
  }

  const verifiedFields =
    decision === 'approved'
      ? JSON.stringify(getVerifiedFieldsForKYBLevel(record.targetLevel))
      : record.verifiedFields;

  const updated = await db
    .update(kybRecords)
    .set({
      status: decision,
      verifiedFields,
      rejectionReason: decision === 'rejected' ? reason : undefined,
      reviewerId,
      reviewedAt: now,
      nextStep: decision === 'approved' ? undefined : record.nextStep,
    })
    .where(eq(kybRecords.id, recordId))
    .returning();

  if (decision === 'approved') {
    await db
      .update(users)
      .set({
        kybLevel: record.targetLevel,
        isBusinessUser: true,
        updatedAt: now,
      })
      .where(eq(users.id, record.userId));
  }

  return updated[0];
}

/**
 * List pending KYC/KYB records for admin review queue.
 */
export async function listPendingReviews(): Promise<{
  kyc: KycRecord[];
  kyb: KybRecord[];
}> {
  const db = getDatabase();

  const pendingKyc = await db
    .select()
    .from(kycRecords)
    .where(eq(kycRecords.status, 'pending'))
    .orderBy(kycRecords.submittedAt)
    .all();

  const pendingKyb = await db
    .select()
    .from(kybRecords)
    .where(eq(kybRecords.status, 'pending'))
    .orderBy(kybRecords.submittedAt)
    .all();

  return { kyc: pendingKyc, kyb: pendingKyb };
}

// =============================================================================
// HELPERS
// =============================================================================

function getNextKYCStep(currentLevel: string, country: string): string {
  const countrySteps: Record<string, Record<string, string>> = {
    NG: { none: 'submit_bvn', basic: 'upload_document', full: 'liveness_check' },
    KE: { none: 'submit_huduma_namba', basic: 'upload_document', full: 'liveness_check' },
    GH: { none: 'submit_ghana_card', basic: 'upload_document', full: 'liveness_check' },
    ZA: { none: 'submit_sa_id', basic: 'upload_document', full: 'liveness_check' },
    EG: { none: 'submit_national_id', basic: 'upload_document', full: 'liveness_check' },
    RW: { none: 'submit_national_id', basic: 'upload_document', full: 'liveness_check' },
    UG: { none: 'submit_national_id', basic: 'upload_document', full: 'liveness_check' },
    TZ: { none: 'submit_nida', basic: 'upload_document', full: 'liveness_check' },
  };

  return countrySteps[country]?.[currentLevel] ?? 'submit_national_id';
}

function getVerifiedFieldsForLevel(level: string): string[] {
  switch (level) {
    case 'basic':
      return ['phone', 'national_id'];
    case 'full':
      return ['phone', 'national_id', 'document', 'selfie'];
    case 'enhanced':
      return ['phone', 'national_id', 'document', 'selfie', 'liveness', 'address'];
    default:
      return [];
  }
}

function getVerifiedFieldsForKYBLevel(level: string): string[] {
  switch (level) {
    case 'registered':
      return ['business_name', 'registration_number'];
    case 'verified':
      return ['business_name', 'registration_number', 'tax_id', 'director_id'];
    case 'trusted':
      return ['business_name', 'registration_number', 'tax_id', 'director_id', 'financial_audit', 'compliance_check'];
    default:
      return [];
  }
}
