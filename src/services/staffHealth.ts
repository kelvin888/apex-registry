/**
 * Staff Health Service
 *
 * Health plan management, employee enrollment, and claims for B2B developers.
 */

import { eq, desc, and, count } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
    getDatabase,
    staffHealthPlans,
    staffEnrollments,
    staffClaims,
} from '../db';

// ─── Seed data helper ─────────────────────────────────────────────────────────

export async function ensureSeedPlans() {
    const db = getDatabase();
    const [existing] = await db.select({ id: staffHealthPlans.id }).from(staffHealthPlans).limit(1);
    if (existing) return;

    const now = new Date();
    await db.insert(staffHealthPlans).values([
        {
            id: nanoid(),
            name: 'Basic Care',
            description: 'Essential outpatient and emergency cover for small teams.',
            tier: 'basic',
            monthlyPremium: 500000,   // ₦5,000 / employee / month
            currency: 'NGN',
            coverageLimit: 20000000,  // ₦200,000
            inpatientCover: true,
            outpatientCover: true,
            dentalCover: false,
            opticalCover: false,
            maternityBenefit: false,
            isActive: true,
            createdAt: now,
        },
        {
            id: nanoid(),
            name: 'Standard Health',
            description: 'Comprehensive cover including dental and optical benefits.',
            tier: 'standard',
            monthlyPremium: 1200000,  // ₦12,000
            currency: 'NGN',
            coverageLimit: 50000000,  // ₦500,000
            inpatientCover: true,
            outpatientCover: true,
            dentalCover: true,
            opticalCover: true,
            maternityBenefit: false,
            isActive: true,
            createdAt: now,
        },
        {
            id: nanoid(),
            name: 'Premium Plus',
            description: 'Full family cover including maternity with top-tier limits.',
            tier: 'premium',
            monthlyPremium: 2500000,  // ₦25,000
            currency: 'NGN',
            coverageLimit: 100000000, // ₦1,000,000
            inpatientCover: true,
            outpatientCover: true,
            dentalCover: true,
            opticalCover: true,
            maternityBenefit: true,
            isActive: true,
            createdAt: now,
        },
    ]);
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export async function listPlans() {
    const db = getDatabase();
    await ensureSeedPlans();
    return db.select().from(staffHealthPlans).where(eq(staffHealthPlans.isActive, true));
}

// ─── Enrollments ──────────────────────────────────────────────────────────────

export async function listEnrollments(developerId: string) {
    const db = getDatabase();
    return db
        .select()
        .from(staffEnrollments)
        .where(eq(staffEnrollments.developerId, developerId))
        .orderBy(desc(staffEnrollments.createdAt));
}

export async function getEnrollment(developerId: string, enrollmentId: string) {
    const db = getDatabase();
    const [row] = await db
        .select()
        .from(staffEnrollments)
        .where(and(eq(staffEnrollments.id, enrollmentId), eq(staffEnrollments.developerId, developerId)))
        .limit(1);
    if (!row) throw Object.assign(new Error('Enrollment not found'), { statusCode: 404 });
    return row;
}

export async function enrollEmployee(
    developerId: string,
    params: {
        planId: string;
        employeeId: string;
        employeeName: string;
        employeeEmail?: string;
        employeePhone?: string;
        dateOfBirth?: string;
        gender?: 'male' | 'female' | 'other';
    },
) {
    const db = getDatabase();

    // Verify plan exists
    const [plan] = await db.select().from(staffHealthPlans).where(eq(staffHealthPlans.id, params.planId)).limit(1);
    if (!plan) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });

    const now = new Date();
    const effectiveDate = now;
    const expiryDate = new Date(now);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    const enrollment = {
        id: nanoid(),
        developerId,
        planId: params.planId,
        employeeId: params.employeeId,
        employeeName: params.employeeName,
        employeeEmail: params.employeeEmail ?? null,
        employeePhone: params.employeePhone ?? null,
        dateOfBirth: params.dateOfBirth ?? null,
        gender: params.gender ?? null,
        status: 'active' as const,
        effectiveDate,
        expiryDate,
        createdAt: now,
        updatedAt: now,
    };

    await db.insert(staffEnrollments).values(enrollment);
    return { ...enrollment, plan };
}

export async function updateEnrollmentStatus(
    developerId: string,
    enrollmentId: string,
    status: 'active' | 'suspended' | 'terminated',
) {
    await getEnrollment(developerId, enrollmentId);
    const db = getDatabase();
    await db
        .update(staffEnrollments)
        .set({ status, updatedAt: new Date() })
        .where(eq(staffEnrollments.id, enrollmentId));
    return getEnrollment(developerId, enrollmentId);
}

// ─── Claims ───────────────────────────────────────────────────────────────────

export async function listClaims(developerId: string, params: { enrollmentId?: string; status?: string } = {}) {
    const db = getDatabase();
    const conditions = [eq(staffClaims.developerId, developerId)];
    if (params.enrollmentId) conditions.push(eq(staffClaims.enrollmentId, params.enrollmentId));
    if (params.status) conditions.push(eq(staffClaims.status, params.status as any));

    return db
        .select()
        .from(staffClaims)
        .where(and(...conditions))
        .orderBy(desc(staffClaims.createdAt));
}

export async function submitClaim(
    developerId: string,
    params: {
        enrollmentId: string;
        claimType: 'inpatient' | 'outpatient' | 'dental' | 'optical' | 'maternity' | 'other';
        amount: number;
        currency?: string;
        providerName?: string;
        diagnosisCode?: string;
        description?: string;
    },
) {
    await getEnrollment(developerId, params.enrollmentId);
    const db = getDatabase();
    const now = new Date();

    const claim = {
        id: nanoid(),
        developerId,
        enrollmentId: params.enrollmentId,
        claimType: params.claimType,
        amount: params.amount,
        approvedAmount: null,
        currency: params.currency ?? 'NGN',
        providerName: params.providerName ?? null,
        diagnosisCode: params.diagnosisCode ?? null,
        description: params.description ?? null,
        status: 'pending' as const,
        submittedAt: now,
        reviewedAt: null,
        paidAt: null,
        rejectionReason: null,
        createdAt: now,
    };

    await db.insert(staffClaims).values(claim);
    return claim;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getHealthSummary(developerId: string) {
    const db = getDatabase();

    const [enrollRows, claimRows] = await Promise.all([
        db.select({ status: staffEnrollments.status }).from(staffEnrollments).where(eq(staffEnrollments.developerId, developerId)),
        db.select({ status: staffClaims.status, amount: staffClaims.amount, approvedAmount: staffClaims.approvedAmount }).from(staffClaims).where(eq(staffClaims.developerId, developerId)),
    ]);

    const totalEmployees = enrollRows.length;
    const activeEmployees = enrollRows.filter((e) => e.status === 'active').length;
    const totalClaims = claimRows.length;
    const pendingClaims = claimRows.filter((c) => c.status === 'pending' || c.status === 'under_review').length;
    const totalClaimValue = claimRows.reduce((s, c) => s + c.amount, 0);
    const approvedClaimValue = claimRows
        .filter((c) => c.status === 'approved' || c.status === 'paid')
        .reduce((s, c) => s + (c.approvedAmount ?? 0), 0);

    return { totalEmployees, activeEmployees, totalClaims, pendingClaims, totalClaimValue, approvedClaimValue, currency: 'NGN' };
}
