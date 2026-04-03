/**
 * Identity Routes
 *
 * End-user KYC/KYB verification endpoints.
 *
 * Authentication model:
 * - /auth endpoints: Host app authenticates with its API key (X-API-Key),
 *   receives a user JWT scoped to the end-user.
 * - All other endpoints: Bearer token (user JWT).
 * - /admin/* endpoints: Developer JWT with admin role.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as identityService from '../services/identity';

// Extend Fastify types for user auth
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

export const identityRoutes: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // USER AUTH — host app exchanges API key + phone for user token
  // =========================================================================

  /**
   * Register or retrieve a user, returning a user-scoped JWT.
   * The host app calls this after authenticating the user locally.
   */
  fastify.post('/auth', {
    onRequest: [fastify.authenticate], // requires host API key or developer JWT
    schema: {
      description: 'Exchange host API key + user phone for a user JWT',
      tags: ['identity'],
      body: {
        type: 'object',
        required: ['phone', 'country'],
        properties: {
          phone: { type: 'string' },
          country: { type: 'string', minLength: 2, maxLength: 2 },
        },
      },
    },
  }, async (request) => {
    const { phone, country } = z
      .object({
        phone: z.string().min(7).max(20),
        country: z.string().length(2).toUpperCase(),
      })
      .parse(request.body);

    const user = await identityService.getOrCreateUser(phone, country);

    const token = fastify.jwt.sign(
      { id: user.id, scope: 'user', country: user.country } as any,
      { expiresIn: '30d' }
    );

    return { token, user: { id: user.id, phone: user.phone, country: user.country } };
  });

  // =========================================================================
  // USER AUTH DECORATOR — validate user JWT for subsequent endpoints
  // =========================================================================

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
  // USER PROFILE
  // =========================================================================

  fastify.get('/profile', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get authenticated user profile',
      tags: ['identity'],
    },
  }, async (request) => {
    const user = await identityService.getUserById(request.userId!);
    if (!user) throw new Error('User not found');

    return {
      userId: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      avatar: user.avatar,
      kycLevel: user.kycLevel,
      kybLevel: user.kybLevel,
      country: user.country,
      isBusinessUser: user.isBusinessUser,
    };
  });

  fastify.patch('/profile', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Update user profile',
      tags: ['identity'],
    },
  }, async (request) => {
    const input = z
      .object({
        firstName: z.string().min(1).max(100).optional(),
        lastName: z.string().min(1).max(100).optional(),
        email: z.string().email().optional(),
        avatar: z.string().url().optional(),
      })
      .parse(request.body);

    const user = await identityService.updateUserProfile(request.userId!, input);

    return {
      userId: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatar: user.avatar,
    };
  });

  // =========================================================================
  // KYC
  // =========================================================================

  fastify.get('/kyc/status', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get KYC verification status',
      tags: ['identity'],
    },
  }, async (request) => {
    return identityService.getKYCStatus(request.userId!);
  });

  fastify.post('/kyc/submit', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Submit KYC verification request',
      tags: ['identity'],
    },
  }, async (request) => {
    const params = z
      .object({
        targetLevel: z.enum(['basic', 'full', 'enhanced']),
        country: z.string().length(2).toUpperCase().optional(),
        nationalIdType: z.string().optional(),
        nationalIdValue: z.string().optional(),
        documentType: z.string().optional(),
      })
      .parse(request.body);

    return identityService.submitKYC(request.userId!, params);
  });

  // =========================================================================
  // KYB
  // =========================================================================

  fastify.get('/kyb/status', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get KYB verification status',
      tags: ['identity'],
    },
  }, async (request) => {
    return identityService.getKYBStatus(request.userId!);
  });

  fastify.post('/kyb/submit', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Submit KYB verification request',
      tags: ['identity'],
    },
  }, async (request) => {
    const params = z
      .object({
        targetLevel: z.enum(['registered', 'verified', 'trusted']),
        country: z.string().length(2).toUpperCase().optional(),
        businessType: z.enum(['sole_proprietor', 'llc', 'plc', 'ngo', 'cooperative']).optional(),
        businessName: z.string().min(1).max(200).optional(),
        registrationNumber: z.string().optional(),
        taxId: z.string().optional(),
      })
      .parse(request.body);

    return identityService.submitKYB(request.userId!, params);
  });

  // =========================================================================
  // ADMIN REVIEW
  // =========================================================================

  const requireAdmin = async (request: any, reply: any) => {
    try {
      // Use developer auth (JWT or API key)
      await fastify.authenticate(request, reply);
      if (request.user?.role !== 'admin') {
        reply.code(403).send({ error: 'Admin access required' });
      }
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  fastify.get('/admin/queue', {
    onRequest: [requireAdmin],
    schema: {
      description: 'List pending KYC/KYB verification requests',
      tags: ['identity', 'admin'],
    },
  }, async () => {
    return identityService.listPendingReviews();
  });

  fastify.post('/admin/kyc/:recordId/review', {
    onRequest: [requireAdmin],
    schema: {
      description: 'Review a KYC submission',
      tags: ['identity', 'admin'],
    },
  }, async (request) => {
    const { recordId } = request.params as { recordId: string };
    const { decision, reason } = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().optional(),
      })
      .parse(request.body);

    return identityService.reviewKYC(recordId, (request as any).user.id, decision, reason);
  });

  fastify.post('/admin/kyb/:recordId/review', {
    onRequest: [requireAdmin],
    schema: {
      description: 'Review a KYB submission',
      tags: ['identity', 'admin'],
    },
  }, async (request) => {
    const { recordId } = request.params as { recordId: string };
    const { decision, reason } = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().optional(),
      })
      .parse(request.body);

    return identityService.reviewKYB(recordId, (request as any).user.id, decision, reason);
  });
};
