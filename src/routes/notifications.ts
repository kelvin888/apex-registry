/**
 * Notifications Routes
 *
 * Push registration, in-app notification list, mark-read, send, preferences.
 * All endpoints require user JWT (scope: 'user').
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as notificationsService from '../services/notifications';

export const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  // =========================================================================
  // USER AUTH DECORATOR
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
  // REGISTER PUSH TOKEN
  // =========================================================================

  fastify.post('/register-push', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Register device push token',
      tags: ['notifications'],
      body: {
        type: 'object',
        required: ['token', 'platform'],
        properties: {
          token: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: ['android', 'ios', 'web'] },
          categories: {
            type: 'array',
            items: { type: 'string', enum: ['transactional', 'promotional', 'system'] },
          },
        },
      },
    },
  }, async (request) => {
    const body = z.object({
      token: z.string().min(1),
      platform: z.enum(['android', 'ios', 'web']),
      categories: z.array(z.enum(['transactional', 'promotional', 'system'])).optional(),
    }).parse(request.body);

    return notificationsService.registerPush(request.userId!, body);
  });

  // =========================================================================
  // GET NOTIFICATIONS
  // =========================================================================

  fastify.get('/list', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get in-app notifications',
      tags: ['notifications'],
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['transactional', 'promotional', 'system'] },
          status: { type: 'string', enum: ['unread', 'read', 'dismissed'] },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request) => {
    const params = z.object({
      type: z.enum(['transactional', 'promotional', 'system']).optional(),
      status: z.enum(['unread', 'read', 'dismissed']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(request.query);

    return notificationsService.getNotifications(request.userId!, params);
  });

  // =========================================================================
  // MARK READ
  // =========================================================================

  fastify.post('/mark-read', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Mark notifications as read',
      tags: ['notifications'],
      body: {
        type: 'object',
        required: ['notificationIds'],
        properties: {
          notificationIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 100,
          },
        },
      },
    },
  }, async (request) => {
    const { notificationIds } = z.object({
      notificationIds: z.array(z.string().min(1)).min(1).max(100),
    }).parse(request.body);

    return notificationsService.markRead(request.userId!, notificationIds);
  });

  // =========================================================================
  // SEND NOTIFICATION
  // =========================================================================

  fastify.post('/send', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Send a notification',
      tags: ['notifications'],
      body: {
        type: 'object',
        required: ['type', 'title', 'body'],
        properties: {
          recipientId: { type: 'string' },
          type: { type: 'string', enum: ['transactional', 'promotional', 'system'] },
          title: { type: 'string', minLength: 1, maxLength: 100 },
          body: { type: 'string', minLength: 1, maxLength: 500 },
          deepLink: { type: 'string', maxLength: 500 },
          metadata: { type: 'object' },
        },
      },
    },
  }, async (request) => {
    const body = z.object({
      recipientId: z.string().optional(),
      type: z.enum(['transactional', 'promotional', 'system']),
      title: z.string().min(1).max(100),
      body: z.string().min(1).max(500),
      deepLink: z.string().max(500).optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body);

    return notificationsService.sendNotification(request.userId!, body);
  });

  // =========================================================================
  // PREFERENCES
  // =========================================================================

  fastify.get('/preferences', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Get notification preferences',
      tags: ['notifications'],
    },
  }, async (request) => {
    return notificationsService.getPreferences(request.userId!);
  });

  fastify.put('/preferences', {
    onRequest: [authenticateUser],
    schema: {
      description: 'Update notification preference for a category',
      tags: ['notifications'],
      body: {
        type: 'object',
        required: ['category'],
        properties: {
          category: { type: 'string', enum: ['transactional', 'promotional', 'system'] },
          pushEnabled: { type: 'boolean' },
          inAppEnabled: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const body = z.object({
      category: z.enum(['transactional', 'promotional', 'system']),
      pushEnabled: z.boolean().optional(),
      inAppEnabled: z.boolean().optional(),
    }).parse(request.body);

    return notificationsService.updatePreference(request.userId!, body);
  });
};
