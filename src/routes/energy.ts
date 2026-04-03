/**
 * Energy Routes
 *
 * Electricity token purchase, solar SHS payments,
 * cooking gas refills, meter management, purchase history.
 */

import { FastifyPluginAsync } from 'fastify';
import * as energyService from '../services/energy';

export const energyRoutes: FastifyPluginAsync = async (fastify) => {
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
  // PROVIDERS
  // =========================================================================

  fastify.get('/providers', async (request) => {
    const { type } = request.query as { type?: 'electricity' | 'solar' | 'gas' };
    return { providers: energyService.getProviders(type) };
  });

  fastify.get('/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = energyService.getProvider(id);
    if (!provider) return reply.code(404).send({ error: 'Provider not found' });
    return provider;
  });

  // =========================================================================
  // METER VALIDATION
  // =========================================================================

  fastify.post('/validate-meter', async (request, reply) => {
    const body = request.body as { providerId: string; meterNumber: string; meterType: string };
    if (!body.providerId || !body.meterNumber || !body.meterType) {
      return reply.code(400).send({ error: 'providerId, meterNumber, and meterType are required' });
    }
    try {
      const result = energyService.validateMeter(body);
      return result;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // =========================================================================
  // ELECTRICITY PURCHASE
  // =========================================================================

  fastify.post('/electricity/purchase', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as { providerId: string; meterNumber: string; meterType: string; customerName: string; amount: number };
    if (!body.providerId || !body.meterNumber || !body.meterType || !body.amount) {
      return reply.code(400).send({ error: 'providerId, meterNumber, meterType, and amount are required' });
    }
    if (body.amount < 50000) { // Min ₦500
      return reply.code(400).send({ error: 'Minimum purchase amount is ₦500' });
    }
    try {
      const result = await energyService.purchaseElectricity({
        userId: (request as any).userId,
        ...body,
      });
      return result;
    } catch (err: any) {
      const code = err.message.includes('Insufficient') ? 402 : 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  // =========================================================================
  // SAVED METERS
  // =========================================================================

  fastify.get('/meters', { preHandler: [authenticateUser] }, async (request) => {
    const { type } = request.query as { type?: string };
    return { meters: energyService.getSavedMeters((request as any).userId, type) };
  });

  fastify.post('/meters', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as { providerId: string; type: 'electricity' | 'solar' | 'gas'; meterNumber: string; meterType?: string; customerName?: string; address?: string; alias?: string };
    if (!body.providerId || !body.type || !body.meterNumber) {
      return reply.code(400).send({ error: 'providerId, type, and meterNumber are required' });
    }
    try {
      const result = energyService.saveMeter({ userId: (request as any).userId, ...body });
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(409).send({ error: err.message });
    }
  });

  fastify.delete('/meters/:id', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return energyService.deleteSavedMeter((request as any).userId, id);
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // =========================================================================
  // PURCHASE HISTORY
  // =========================================================================

  fastify.get('/purchases', { preHandler: [authenticateUser] }, async (request) => {
    const { type, limit, offset } = request.query as { type?: string; limit?: string; offset?: string };
    return energyService.getPurchaseHistory(
      (request as any).userId,
      type,
      limit ? parseInt(limit, 10) : undefined,
      offset ? parseInt(offset, 10) : undefined,
    );
  });

  fastify.get('/purchases/:id', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const purchase = energyService.getPurchase((request as any).userId, id);
    if (!purchase) return reply.code(404).send({ error: 'Purchase not found' });
    return purchase;
  });

  // =========================================================================
  // SOLAR HOME SYSTEMS
  // =========================================================================

  fastify.get('/solar/devices', { preHandler: [authenticateUser] }, async (request) => {
    return { devices: energyService.getSolarDevices((request as any).userId) };
  });

  fastify.get('/solar/devices/:id', { preHandler: [authenticateUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = energyService.getSolarDevice((request as any).userId, id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    return device;
  });

  fastify.post('/solar/devices', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as { providerId: string; deviceSerial: string; deviceModel?: string; totalCost: number };
    if (!body.providerId || !body.deviceSerial || !body.totalCost) {
      return reply.code(400).send({ error: 'providerId, deviceSerial, and totalCost are required' });
    }
    try {
      const result = energyService.registerSolarDevice({ userId: (request as any).userId, ...body });
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(409).send({ error: err.message });
    }
  });

  fastify.post('/solar/pay', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as { deviceId: string; amount: number };
    if (!body.deviceId || !body.amount) {
      return reply.code(400).send({ error: 'deviceId and amount are required' });
    }
    if (body.amount < 50000) {
      return reply.code(400).send({ error: 'Minimum payment is ₦500' });
    }
    try {
      const result = await energyService.paySolar({ userId: (request as any).userId, ...body });
      return result;
    } catch (err: any) {
      const code = err.message.includes('Insufficient') ? 402 : 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  // =========================================================================
  // GAS VENDORS & ORDERS
  // =========================================================================

  fastify.get('/gas/vendors', async (request) => {
    const { city } = request.query as { city?: string };
    return { vendors: energyService.getGasVendors(city) };
  });

  fastify.get('/gas/vendors/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const vendor = energyService.getGasVendor(id);
    if (!vendor) return reply.code(404).send({ error: 'Vendor not found' });
    return vendor;
  });

  fastify.post('/gas/order', { preHandler: [authenticateUser] }, async (request, reply) => {
    const body = request.body as { vendorId: string; cylinderSize: string; deliveryMethod: 'pickup' | 'delivery'; deliveryAddress?: string };
    if (!body.vendorId || !body.cylinderSize || !body.deliveryMethod) {
      return reply.code(400).send({ error: 'vendorId, cylinderSize, and deliveryMethod are required' });
    }
    try {
      const result = await energyService.orderGas({ userId: (request as any).userId, ...body });
      return result;
    } catch (err: any) {
      const code = err.message.includes('Insufficient') ? 402 : 400;
      return reply.code(code).send({ error: err.message });
    }
  });
};
