/**
 * Transport Routes
 *
 * Bus/BRT, ferry, rail ticket purchase.
 * Schedule lookup, QR ticket retrieval, validation, ride-hail partner list.
 */

import { FastifyPluginAsync } from 'fastify';
import * as transportService from '../services/transport';

export const transportRoutes: FastifyPluginAsync = async (fastify) => {
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
  // OPERATORS
  // =========================================================================

  /** GET /api/transport/operators?city=Lagos&type=brt */
  fastify.get('/operators', async (request) => {
    const { city, type } = request.query as { city?: string; type?: string };
    return { operators: transportService.getOperators(city, type) };
  });

  // =========================================================================
  // ROUTES & SCHEDULES
  // =========================================================================

  /** GET /api/transport/routes?operatorId=OP_LAGOS_BRT */
  fastify.get('/routes', async (request) => {
    const { operatorId } = request.query as { operatorId?: string };
    return { routes: transportService.getRoutes(operatorId) };
  });

  /** GET /api/transport/routes/:routeId/schedules */
  fastify.get('/routes/:routeId/schedules', async (request, reply) => {
    const { routeId } = request.params as { routeId: string };
    try {
      return { schedules: transportService.getSchedules(routeId) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // =========================================================================
  // TICKET PURCHASE
  // =========================================================================

  /**
   * POST /api/transport/tickets/purchase
   * Body: { routeId, scheduleId?, ticketType, adultCount, childCount?, walletId }
   */
  fastify.post('/tickets/purchase', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as {
      routeId: string;
      scheduleId?: string;
      ticketType: 'single' | 'return' | 'day_pass' | 'weekly_pass';
      adultCount?: number;
      childCount?: number;
      walletId: string;
    };

    if (!body.routeId || !body.ticketType || !body.walletId) {
      return reply.code(400).send({ error: 'routeId, ticketType, and walletId are required' });
    }
    const validTypes = ['single', 'return', 'day_pass', 'weekly_pass'];
    if (!validTypes.includes(body.ticketType)) {
      return reply.code(400).send({ error: 'Invalid ticketType. Must be: single, return, day_pass, weekly_pass' });
    }
    const adultCount = Math.max(1, body.adultCount ?? 1);
    const childCount = Math.max(0, body.childCount ?? 0);
    if (adultCount + childCount > 10) {
      return reply.code(400).send({ error: 'Maximum 10 passengers per booking' });
    }

    try {
      const ticket = await transportService.purchaseTicket({
        userId: (request as any).userId,
        routeId: body.routeId,
        scheduleId: body.scheduleId,
        ticketType: body.ticketType,
        adultCount,
        childCount,
        walletId: body.walletId,
      });
      return ticket;
    } catch (err: any) {
      const code = err.message.includes('Insufficient') ? 402
        : err.message.includes('not found') ? 404
          : 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  // =========================================================================
  // MY TICKETS
  // =========================================================================

  /** GET /api/transport/tickets?status=active */
  fastify.get('/tickets', { preHandler: [authenticateUser] }, async (request) => {
    const { status } = request.query as { status?: string };
    return { tickets: transportService.getMyTickets((request as any).userId, status) };
  });

  /** GET /api/transport/tickets/:ticketId */
  fastify.get('/tickets/:ticketId', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };
    try {
      const ticket = transportService.getTicket(ticketId, (request as any).userId);
      return ticket;
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // =========================================================================
  // TICKET VALIDATION (boarding agent endpoint — no user auth required, uses ticketId only)
  // =========================================================================

  /** POST /api/transport/tickets/:ticketId/validate */
  fastify.post('/tickets/:ticketId/validate', async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };
    try {
      const result = transportService.validateTicket(ticketId);
      return { valid: true, ticket: result };
    } catch (err: any) {
      const status = err.message.includes('already been used') || err.message.includes('expired')
        ? 409
        : err.message.includes('not found') ? 404
          : 400;
      return reply.code(status).send({ valid: false, error: err.message });
    }
  });

  // =========================================================================
  // RIDE-HAIL PARTNERS
  // =========================================================================

  /** GET /api/transport/ridehail/partners?country=NG */
  fastify.get('/ridehail/partners', async (request) => {
    const { country } = request.query as { country?: string };
    return { partners: transportService.getPartners(country) };
  });

  // =========================================================================
  // HISTORY
  // =========================================================================

  /** GET /api/transport/history?limit=20 */
  fastify.get('/history', { preHandler: [authenticateUser] }, async (request) => {
    const { limit } = request.query as { limit?: string };
    return { history: transportService.getHistory((request as any).userId, limit ? parseInt(limit, 10) : 20) };
  });
};
