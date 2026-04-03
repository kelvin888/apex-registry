/**
 * Health Routes
 *
 * Provider directory, appointments, consultations, prescriptions,
 * pharmacy orders, and lab test bookings.
 * Mutation endpoints require user JWT.
 */

import { FastifyPluginAsync } from 'fastify';
import * as healthService from '../services/health';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const authenticateUser = async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      const payload = request.user as { sub?: string; scope?: string };
      if (payload.scope !== 'user' || !payload.sub) {
        reply.code(401).send({ error: 'Invalid user token' });
        return;
      }
      request.userId = payload.sub;
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // =========================================================================
  // SPECIALTIES
  // =========================================================================

  fastify.get('/specialties', async () => {
    return { specialties: healthService.getSpecialties() };
  });

  // =========================================================================
  // PROVIDERS
  // =========================================================================

  fastify.get('/providers', async (request) => {
    const q = request.query as any;
    const providers = healthService.getProviders({
      type: q.type,
      specialty: q.specialty,
      city: q.city,
      country: q.country || 'NG',
      availableNow: q.availableNow === 'true',
      search: q.search,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
      offset: q.offset ? parseInt(q.offset, 10) : 0,
    });
    return { providers };
  });

  fastify.get('/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params as any;
    const provider = healthService.getProvider(providerId);
    if (!provider) {
      reply.code(404).send({ error: 'Provider not found' });
      return;
    }
    return { provider };
  });

  // =========================================================================
  // APPOINTMENTS
  // =========================================================================

  fastify.post('/appointments', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { providerId, type, scheduledAt, notes } = request.body as any;
    if (!providerId || !type || !scheduledAt) {
      reply.code(400).send({ error: 'providerId, type, and scheduledAt are required' });
      return;
    }
    try {
      const result = healthService.bookAppointment({
        patientId: (request as any).userId,
        providerId,
        type,
        scheduledAt,
        notes,
      });
      return result;
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/appointments', { preHandler: [authenticateUser] }, async (request) => {
    const q = request.query as any;
    const results = healthService.getAppointments((request as any).userId, q.status);
    return { appointments: results };
  });

  fastify.get('/appointments/:appointmentId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { appointmentId } = request.params as any;
    const result = healthService.getAppointment(appointmentId);
    if (!result) {
      reply.code(404).send({ error: 'Appointment not found' });
      return;
    }
    return result;
  });

  fastify.delete('/appointments/:appointmentId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { appointmentId } = request.params as any;
    const { reason } = request.body as any || {};
    try {
      const result = healthService.cancelAppointment(appointmentId, (request as any).userId, reason);
      return result;
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  // =========================================================================
  // CONSULTATIONS
  // =========================================================================

  fastify.post('/consultations/start', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { appointmentId } = request.body as any;
    if (!appointmentId) {
      reply.code(400).send({ error: 'appointmentId is required' });
      return;
    }
    try {
      return healthService.startConsultation(appointmentId, (request as any).userId);
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.post('/consultations/:consultationId/messages', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { consultationId } = request.params as any;
    const { type, content, mediaUrl } = request.body as any;
    if (!type || !content) {
      reply.code(400).send({ error: 'type and content are required' });
      return;
    }
    return healthService.sendMessage({
      consultationId,
      senderId: (request as any).userId,
      senderRole: 'patient',
      type,
      content,
      mediaUrl,
    });
  });

  fastify.get('/consultations/:consultationId/messages', { preHandler: [authenticateUser] }, async (request) => {
    const { consultationId } = request.params as any;
    const messages = healthService.getMessages(consultationId);
    return { messages };
  });

  fastify.post('/consultations/:consultationId/end', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { consultationId } = request.params as any;
    const { summary } = request.body as any || {};
    try {
      return healthService.endConsultation(consultationId, summary);
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  // =========================================================================
  // PRESCRIPTIONS
  // =========================================================================

  fastify.post('/prescriptions', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { consultationId, diagnosis, notes, items } = request.body as any;
    if (!consultationId || !diagnosis || !items?.length) {
      reply.code(400).send({ error: 'consultationId, diagnosis, and items are required' });
      return;
    }
    try {
      return healthService.createPrescription({
        consultationId,
        providerId: (request as any).userId,
        diagnosis,
        notes,
        items,
      });
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/prescriptions', { preHandler: [authenticateUser] }, async (request) => {
    const results = healthService.getPatientPrescriptions((request as any).userId);
    return { prescriptions: results };
  });

  fastify.get('/prescriptions/:prescriptionId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { prescriptionId } = request.params as any;
    const result = healthService.getPrescription(prescriptionId);
    if (!result) {
      reply.code(404).send({ error: 'Prescription not found' });
      return;
    }
    return { prescription: result };
  });

  // =========================================================================
  // PHARMACY ORDERS
  // =========================================================================

  fastify.post('/pharmacy/orders', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { pharmacyId, prescriptionId, deliveryMethod, deliveryAddress, items } = request.body as any;
    if (!pharmacyId || !deliveryMethod || !items?.length) {
      reply.code(400).send({ error: 'pharmacyId, deliveryMethod, and items are required' });
      return;
    }
    try {
      return healthService.createPharmacyOrder({
        patientId: (request as any).userId,
        pharmacyId,
        prescriptionId,
        deliveryMethod,
        deliveryAddress,
        items,
      });
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/pharmacy/orders', { preHandler: [authenticateUser] }, async (request) => {
    const results = healthService.getPatientOrders((request as any).userId);
    return { orders: results };
  });

  fastify.get('/pharmacy/orders/:orderId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { orderId } = request.params as any;
    const result = healthService.getPharmacyOrder(orderId);
    if (!result) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    return { order: result };
  });

  // =========================================================================
  // LAB TESTS
  // =========================================================================

  fastify.get('/lab-tests', async (request) => {
    const q = request.query as any;
    const tests = healthService.getLabTests(q.category);
    return { tests };
  });

  fastify.post('/lab-tests/book', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { labId, testId, scheduledAt, prescriptionId } = request.body as any;
    if (!labId || !testId || !scheduledAt) {
      reply.code(400).send({ error: 'labId, testId, and scheduledAt are required' });
      return;
    }
    try {
      return healthService.bookLabTest({
        patientId: (request as any).userId,
        labId,
        testId,
        scheduledAt,
        prescriptionId,
      });
    } catch (e: any) {
      reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/lab-tests/bookings', { preHandler: [authenticateUser] }, async (request) => {
    const results = healthService.getPatientLabBookings((request as any).userId);
    return { bookings: results };
  });

  fastify.get('/lab-tests/bookings/:bookingId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { bookingId } = request.params as any;
    const result = healthService.getLabBooking(bookingId);
    if (!result) {
      reply.code(404).send({ error: 'Booking not found' });
      return;
    }
    return { booking: result };
  });
};
