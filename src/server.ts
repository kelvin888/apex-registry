/**
 * Server Setup
 *
 * Configures and creates the Fastify server
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { type Config } from './config';
import { initDatabase, runMigrations, getDatabase, developers } from './db';
import { getDatabasePath } from './config';
import * as authService from './services/auth';
import { authRoutes, appsRoutes, versionsRoutes, registryRoutes, dashboardRoutes, adminRoutes } from './routes';
import { eq } from 'drizzle-orm';

// Extend Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string; role: string };
    user: { id: string; email: string; role: string };
  }
}

export interface ServerOptions {
  config: Config;
  logger?: boolean;
}

/**
 * Create and configure the server
 */
export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { config } = options;

  // Initialize database
  initDatabase({ path: getDatabasePath(config) });
  runMigrations();

  // Create Fastify instance
  const fastify = Fastify({
    logger: options.logger === false ? false : {
      level: config.logLevel,
      transport: config.nodeEnv === 'development' ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
        },
      } : undefined,
    },
  });

  // Register CORS
  await fastify.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  });

  // Register multipart for file uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: config.maxPackageSize,
    },
  });

  // Register JWT
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    sign: {
      expiresIn: config.jwtExpiresIn,
    },
  });

  // Register rate limiting
  await fastify.register(rateLimit, {
    max: config.rateLimit,
    timeWindow: config.rateLimitWindow,
  });

  // Register Swagger
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'APEX Distribution Server',
        description: 'API for hosting and distributing APEX mini-app packages',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
          },
        },
      },
      tags: [
        { name: 'auth', description: 'Authentication endpoints' },
        { name: 'apps', description: 'App management endpoints' },
        { name: 'versions', description: 'Version management endpoints' },
        { name: 'registry', description: 'Public registry endpoints' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Authentication decorator
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      // Check for API key first
      const apiKey = request.headers['x-api-key'];
      if (apiKey) {
        const developer = await authService.verifyApiKey(apiKey);
        if (developer) {
          if (developer.suspended) {
            reply.code(401).send({ error: 'Account suspended' });
            return;
          }
          request.user = {
            id: developer.id,
            email: developer.email,
            role: developer.role,
          };
          return;
        }
      }

      // Fall back to JWT — verify token then fetch live user to check suspension
      await request.jwtVerify();
      const liveUser = await authService.getDeveloperById(request.user.id);
      if (!liveUser) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      if (liveUser.suspended) {
        reply.code(401).send({ error: 'Account suspended' });
        return;
      }
      // Sync role in case it was changed after token issuance
      request.user.role = liveUser.role;
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Health check
  fastify.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // One-time admin bootstrap — protected by BOOTSTRAP_SECRET env var
  fastify.post('/api/admin/bootstrap', async (request: any, reply: any) => {
    const secret = process.env.BOOTSTRAP_SECRET;
    if (!secret) {
      reply.code(403).send({ error: 'Bootstrap is disabled (BOOTSTRAP_SECRET not set)' });
      return;
    }
    const { email, secret: provided } = request.body as { email?: string; secret?: string };
    if (!provided || provided !== secret) {
      reply.code(403).send({ error: 'Invalid secret' });
      return;
    }
    if (!email) {
      reply.code(400).send({ error: 'email is required' });
      return;
    }
    const db = getDatabase();
    const existing = db.select({ id: developers.id, role: developers.role })
      .from(developers).where(eq(developers.email, email)).get();
    if (!existing) {
      reply.code(404).send({ error: `No account found for ${email}` });
      return;
    }
    if (existing.role === 'admin') {
      return { message: `${email} is already an admin` };
    }
    db.update(developers).set({ role: 'admin', updatedAt: new Date() })
      .where(eq(developers.email, email)).run();
    return { message: `✓ ${email} promoted to admin` };
  });

  // Error handler — must be registered before route plugins so child scopes
  // inherit it and Fastify doesn't fall back to its built-in format.
  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error);

    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 && config.nodeEnv === 'production'
      ? 'Internal server error'
      : error.message;

    reply.code(statusCode).send({
      error: message,
      statusCode,
    });
  });

  // Register routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(appsRoutes, { prefix: '/api/apps' });
  await fastify.register(versionsRoutes, { prefix: '/api/apps' });
  await fastify.register(registryRoutes, { prefix: '/api/registry' });
  await fastify.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await fastify.register(adminRoutes, { prefix: '/api/admin' });

  return fastify;
}

/**
 * Start the server
 */
export async function startServer(fastify: FastifyInstance, config: Config): Promise<void> {
  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 APEX Distribution Server                             ║
║                                                           ║
║   Server:  http://${config.host}:${config.port}                       ║
║   Docs:    http://${config.host}:${config.port}/docs                  ║
║   Mode:    ${config.nodeEnv.padEnd(45)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}
