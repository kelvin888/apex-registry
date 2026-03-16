/**
 * Server Configuration
 *
 * Loads and validates configuration from environment variables
 */

import { z } from 'zod';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env file
dotenv.config();

/**
 * Configuration schema
 */
const configSchema = z.object({
  // Server
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().default(4000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  databasePath: z.string().default('./data/apex.db'),

  // JWT
  jwtSecret: z.string().min(32),
  jwtExpiresIn: z.string().default('7d'),

  // Storage
  storagePath: z.string().default('./data/packages'),
  maxPackageSize: z.coerce.number().default(50 * 1024 * 1024), // 50MB

  // Rate limiting
  rateLimit: z.coerce.number().default(100), // requests per minute
  rateLimitWindow: z.coerce.number().default(60 * 1000), // 1 minute

  // CORS
  corsOrigins: z.string().transform(s => s.split(',')).default('*'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load configuration from environment
 */
export function loadConfig(): Config {
  const raw = {
    // Force IPv4 - Railway doesn't support IPv6 binding well
    host: (process.env.HOST === '::' || process.env.HOST === '[::]') ? '0.0.0.0' : process.env.HOST,
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    databasePath: process.env.DATABASE_PATH,
    jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'development' ? 'dev-secret-key-for-local-development-only!' : undefined),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN,
    storagePath: process.env.STORAGE_PATH,
    maxPackageSize: process.env.MAX_PACKAGE_SIZE,
    rateLimit: process.env.RATE_LIMIT,
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW,
    corsOrigins: process.env.CORS_ORIGINS,
    logLevel: process.env.LOG_LEVEL,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    console.error('Invalid configuration:');
    for (const error of result.error.errors) {
      console.error(`  ${error.path.join('.')}: ${error.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

/**
 * Get absolute storage path
 */
export function getStoragePath(config: Config, ...segments: string[]): string {
  const base = path.isAbsolute(config.storagePath)
    ? config.storagePath
    : path.resolve(process.cwd(), config.storagePath);

  return path.join(base, ...segments);
}

/**
 * Get absolute database path
 */
export function getDatabasePath(config: Config): string {
  return path.isAbsolute(config.databasePath)
    ? config.databasePath
    : path.resolve(process.cwd(), config.databasePath);
}
