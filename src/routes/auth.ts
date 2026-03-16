/**
 * Auth Routes
 *
 * Authentication and developer account endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as authService from '../services/auth';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  organization: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

const createApiKeySchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.enum(['read', 'upload', 'publish', 'delete'])),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Register new developer
   */
  fastify.post('/register', {
    schema: {
      description: 'Register a new developer account',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['email', 'password', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string', minLength: 2 },
          organization: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            developer: { type: 'object' },
            apiKey: { type: 'string' },
            token: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = registerSchema.parse(request.body);

    try {
      const result = await authService.registerDeveloper(input);

      // Generate JWT
      const token = fastify.jwt.sign({
        id: result.developer.id,
        email: result.developer.email,
        role: result.developer.role,
      });

      return {
        developer: result.developer,
        apiKey: result.apiKey,
        token,
      };
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * Login
   */
  fastify.post('/login', {
    schema: {
      description: 'Login to developer account',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const input = loginSchema.parse(request.body);

    try {
      const result = await authService.loginDeveloper(input);

      const token = fastify.jwt.sign({
        id: result.developer.id,
        email: result.developer.email,
        role: result.developer.role,
      });

      return {
        developer: result.developer,
        token,
      };
    } catch (error) {
      reply.code(401);
      throw error;
    }
  });

  /**
   * Get current user
   */
  fastify.get('/me', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Get current developer profile',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const developer = await authService.getDeveloperById(request.user.id);
    if (!developer) {
      throw new Error('Developer not found');
    }
    return developer;
  });

  /**
   * Change password
   */
  fastify.post('/change-password', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Change account password',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string' },
          newPassword: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const input = changePasswordSchema.parse(request.body);

    try {
      await authService.changePassword(request.user.id, input.currentPassword, input.newPassword);
      return { success: true };
    } catch (error) {
      reply.code(400);
      throw error;
    }
  });

  /**
   * List API keys
   */
  fastify.get('/api-keys', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'List API keys for current developer',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const keys = await authService.listApiKeys(request.user.id);
    return { keys };
  });

  /**
   * Create API key
   */
  fastify.post('/api-keys', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Create a new API key',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'permissions'],
        properties: {
          name: { type: 'string' },
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'upload', 'publish', 'delete'] },
          },
        },
      },
    },
  }, async (request) => {
    const input = createApiKeySchema.parse(request.body);
    const key = await authService.createApiKey(request.user.id, input.name, input.permissions);

    return {
      key,
      message: 'Store this key securely. It will not be shown again.',
    };
  });

  /**
   * Revoke API key
   */
  fastify.delete('/api-keys/:keyId', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Revoke an API key',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['keyId'],
        properties: {
          keyId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { keyId } = request.params as { keyId: string };

    const success = await authService.revokeApiKey(request.user.id, keyId);
    if (!success) {
      reply.code(404);
      throw new Error('API key not found');
    }

    return { success: true };
  });
};
