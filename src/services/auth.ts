/**
 * Authentication Service
 *
 * Handles developer registration, login, and API key management
 */

import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDatabase, developers, apiKeys, certificates, type Developer, type NewDeveloper } from '../db';

const SALT_ROUNDS = 12;

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  organization?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResult {
  developer: Omit<Developer, 'passwordHash' | 'apiKeyHash'>;
  apiKey?: string;
}

/**
 * Register a new developer
 */
export async function registerDeveloper(input: RegisterInput): Promise<AuthResult> {
  const db = getDatabase();

  // Check if email exists
  const [existing] = await db.select().from(developers).where(eq(developers.email, input.email)).limit(1);
  if (existing) {
    throw new Error('Email already registered');
  }

  // Generate API key
  const apiKey = `apex_${nanoid(32)}`;
  const apiKeyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const now = new Date();
  const developer: NewDeveloper = {
    id: nanoid(),
    email: input.email,
    passwordHash,
    name: input.name,
    organization: input.organization,
    apiKey: apiKey.slice(0, 12) + '...', // Store partial for display
    apiKeyHash,
    role: 'developer',
    verified: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(developers).values(developer);

  const { passwordHash: _, apiKeyHash: __, ...safe } = developer;

  return {
    developer: safe as Omit<Developer, 'passwordHash' | 'apiKeyHash'>,
    apiKey, // Return full key only once
  };
}

/**
 * Login developer
 */
export async function loginDeveloper(input: LoginInput): Promise<AuthResult> {
  const db = getDatabase();

  const [developer] = await db.select().from(developers).where(eq(developers.email, input.email)).limit(1);
  if (!developer) {
    throw new Error('Invalid credentials');
  }

  const valid = await bcrypt.compare(input.password, developer.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  const { passwordHash, apiKeyHash, ...safe } = developer;

  return { developer: safe };
}

/**
 * Get developer by ID
 */
export async function getDeveloperById(id: string): Promise<Omit<Developer, 'passwordHash' | 'apiKeyHash'> | null> {
  const db = getDatabase();

  const [developer] = await db.select().from(developers).where(eq(developers.id, id)).limit(1);
  if (!developer) {
    return null;
  }

  const { passwordHash, apiKeyHash, ...safe } = developer;
  return safe;
}

/**
 * Verify API key and return developer
 */
export async function verifyApiKey(key: string): Promise<Omit<Developer, 'passwordHash' | 'apiKeyHash'> | null> {
  const db = getDatabase();

  // Get all developers (in production, use a lookup table)
  const allDevelopers = await db.select().from(developers);

  for (const developer of allDevelopers) {
    const valid = await bcrypt.compare(key, developer.apiKeyHash);
    if (valid) {
      const { passwordHash, apiKeyHash, ...safe } = developer;
      return safe;
    }
  }

  // Check additional API keys
  const allKeys = await db.select().from(apiKeys);

  for (const apiKey of allKeys) {
    const valid = await bcrypt.compare(key, apiKey.keyHash);
    if (valid) {
      // Check expiration
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        continue;
      }

      // Update last used
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKey.id));

      const developer = await getDeveloperById(apiKey.developerId);
      return developer;
    }
  }

  return null;
}

/**
 * Create additional API key
 */
export async function createApiKey(developerId: string, name: string, permissions: string[]): Promise<string> {
  const db = getDatabase();

  const key = `apex_${nanoid(32)}`;
  const keyHash = await bcrypt.hash(key, SALT_ROUNDS);

  await db.insert(apiKeys).values({
    id: nanoid(),
    developerId,
    name,
    keyHash,
    keyPrefix: key.slice(0, 12),
    permissions: JSON.stringify(permissions),
    createdAt: new Date(),
  });

  return key;
}

/**
 * List API keys for developer
 */
export async function listApiKeys(developerId: string) {
  const db = getDatabase();

  return db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    permissions: apiKeys.permissions,
    lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.developerId, developerId));
}

/**
 * Revoke API key
 */
export async function revokeApiKey(developerId: string, keyId: string): Promise<boolean> {
  const db = getDatabase();

  const result = await db.delete(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .returning();

  return result.length > 0;
}

/**
 * List certificates for a developer
 */
export async function listCertificates(developerId: string) {
  const db = getDatabase();
  const rows = await db.select().from(certificates).where(eq(certificates.developerId, developerId));
  const now = new Date();
  return rows.map(c => ({
    ...c,
    status: c.expiresAt && c.expiresAt < now ? 'expired' : 'active',
  }));
}

/**
 * Register a certificate (public key) for a developer
 */
export async function registerCertificate(developerId: string, name: string, publicKey: string) {
  const db = getDatabase();

  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');

  const [existing] = await db.select().from(certificates).where(eq(certificates.fingerprint, fingerprint)).limit(1);
  if (existing) {
    throw new Error('This public key is already registered');
  }

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + 2); // 2-year validity

  const id = nanoid();
  await db.insert(certificates).values({
    id,
    developerId,
    name,
    publicKey,
    fingerprint,
    algorithm: 'RSA-SHA256',
    isDefault: false,
    expiresAt,
    createdAt: now,
  });

  return { id, fingerprint, certificate: publicKey, expiresAt };
}

/**
 * Revoke (delete) a certificate owned by a developer
 */
export async function revokeCertificate(developerId: string, certId: string): Promise<boolean> {
  const db = getDatabase();
  const result = await db
    .delete(certificates)
    .where(eq(certificates.id, certId))
    .returning();
  return result.length > 0 && result[0].developerId === developerId;
}

/**
 * Change password
 */
export async function changePassword(developerId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  const db = getDatabase();

  const [developer] = await db.select().from(developers).where(eq(developers.id, developerId)).limit(1);
  if (!developer) {
    throw new Error('Developer not found');
  }

  const valid = await bcrypt.compare(currentPassword, developer.passwordHash);
  if (!valid) {
    throw new Error('Current password is incorrect');
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await db.update(developers)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(developers.id, developerId));

  return true;
}
