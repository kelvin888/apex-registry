/**
 * Staff Health Routes
 *
 * Endpoints at /api/b2b/health for plan catalog, employee enrollment, and claims.
 */

import { FastifyPluginAsync } from 'fastify';
import {
    listPlans,
    getHealthSummary,
    listEnrollments,
    enrollEmployee,
    updateEnrollmentStatus,
    listClaims,
    submitClaim,
} from '../services/staffHealth';

export const staffHealthRoutes: FastifyPluginAsync = async (fastify) => {
    // ─── Plans ────────────────────────────────────────────────────────────────

    fastify.get('/plans', { preHandler: [fastify.authenticate] }, async (_req, reply) => {
        const plans = await listPlans();
        return reply.send({ plans });
    });

    // ─── Summary ──────────────────────────────────────────────────────────────

    fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const summary = await getHealthSummary(developerId);
        return reply.send(summary);
    });

    // ─── Enrollments ──────────────────────────────────────────────────────────

    fastify.get('/enrollments', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const enrollments = await listEnrollments(developerId);
        return reply.send({ enrollments });
    });

    fastify.post<{
        Body: {
            planId: string;
            employeeId: string;
            employeeName: string;
            employeeEmail?: string;
            employeePhone?: string;
            dateOfBirth?: string;
            gender?: 'male' | 'female' | 'other';
        };
    }>('/enrollments', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { planId, employeeId, employeeName, employeeEmail, employeePhone, dateOfBirth, gender } = req.body;

        if (!planId || !employeeId || !employeeName) {
            return reply.status(400).send({ error: 'planId, employeeId, and employeeName are required' });
        }

        const enrollment = await enrollEmployee(developerId, { planId, employeeId, employeeName, employeeEmail, employeePhone, dateOfBirth, gender });
        return reply.status(201).send(enrollment);
    });

    fastify.patch<{
        Params: { id: string };
        Body: { status: 'active' | 'suspended' | 'terminated' };
    }>('/enrollments/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { id: enrollmentId } = req.params;
        const { status } = req.body;

        if (!['active', 'suspended', 'terminated'].includes(status)) {
            return reply.status(400).send({ error: 'Invalid status' });
        }

        const updated = await updateEnrollmentStatus(developerId, enrollmentId, status);
        return reply.send(updated);
    });

    // ─── Claims ───────────────────────────────────────────────────────────────

    fastify.get<{
        Querystring: { enrollmentId?: string; status?: string };
    }>('/claims', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { enrollmentId, status } = req.query;
        const claims = await listClaims(developerId, { enrollmentId, status });
        return reply.send({ claims });
    });

    fastify.post<{
        Body: {
            enrollmentId: string;
            claimType: 'inpatient' | 'outpatient' | 'dental' | 'optical' | 'maternity' | 'other';
            amount: number;
            currency?: string;
            providerName?: string;
            diagnosisCode?: string;
            description?: string;
        };
    }>('/claims', { preHandler: [fastify.authenticate] }, async (req, reply) => {
        const { id: developerId } = req.user as { id: string };
        const { enrollmentId, claimType, amount, currency, providerName, diagnosisCode, description } = req.body;

        const validTypes = ['inpatient', 'outpatient', 'dental', 'optical', 'maternity', 'other'];
        if (!enrollmentId || !claimType || !amount) {
            return reply.status(400).send({ error: 'enrollmentId, claimType, and amount are required' });
        }
        if (!validTypes.includes(claimType)) {
            return reply.status(400).send({ error: 'Invalid claim type' });
        }

        const claim = await submitClaim(developerId, { enrollmentId, claimType, amount, currency, providerName, diagnosisCode, description });
        return reply.status(201).send(claim);
    });
};
