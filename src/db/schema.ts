/**
 * Database Schema
 *
 * Defines the database tables for the distribution server
 */

import { sqliteTable, text, integer, blob, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/**
 * Developers - registered developers/organizations
 */
export const developers = sqliteTable('developers', {
  id: text('id').primaryKey(), // nanoid
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  organization: text('organization'),
  apiKey: text('api_key').notNull().unique(),
  apiKeyHash: text('api_key_hash').notNull(),
  role: text('role', { enum: ['developer', 'admin'] }).notNull().default('developer'),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Apps - registered mini-apps
 */
export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(), // nanoid
  appId: text('app_id').notNull().unique(), // com.example.myapp
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'), // URL to icon
  category: text('category'),
  status: text('status', { enum: ['draft', 'pending', 'approved', 'rejected', 'suspended'] }).notNull().default('draft'),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  appIdIdx: uniqueIndex('app_id_idx').on(table.appId),
  developerIdx: index('developer_idx').on(table.developerId),
  statusIdx: index('status_idx').on(table.status),
}));

/**
 * Versions - app versions/releases
 */
export const versions = sqliteTable('versions', {
  id: text('id').primaryKey(), // nanoid
  appId: text('app_id').notNull().references(() => apps.id),
  version: text('version').notNull(), // semver: 1.0.0
  versionCode: integer('version_code').notNull(), // incremental: 1, 2, 3...
  changelog: text('changelog'),
  minHostVersion: text('min_host_version'), // minimum host app version
  permissions: text('permissions'), // JSON array of required permissions
  status: text('status', { enum: ['uploading', 'processing', 'ready', 'failed'] }).notNull().default('uploading'),
  packagePath: text('package_path'), // path to .map file
  packageSize: integer('package_size'), // bytes
  packageHash: text('package_hash'), // SHA256
  signature: text('signature'), // package signature
  metadata: text('metadata'), // JSON metadata from app.json
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
}, (table) => ({
  appVersionIdx: uniqueIndex('app_version_idx').on(table.appId, table.version),
  appVersionCodeIdx: uniqueIndex('app_version_code_idx').on(table.appId, table.versionCode),
}));

/**
 * Downloads - download analytics
 */
export const downloads = sqliteTable('downloads', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull().references(() => versions.id),
  hostAppId: text('host_app_id'), // which host app downloaded
  hostVersion: text('host_version'),
  platform: text('platform'), // ios, android
  region: text('region'), // country code
  ipHash: text('ip_hash'), // hashed IP for uniqueness
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  versionIdx: index('download_version_idx').on(table.versionId),
  dateIdx: index('download_date_idx').on(table.createdAt),
}));

/**
 * API Keys - additional API keys for CI/CD
 */
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(), // "CI Key", "Production Key"
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(), // first 8 chars for identification
  permissions: text('permissions').notNull(), // JSON array: ["upload", "publish"]
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  developerIdx: index('api_key_developer_idx').on(table.developerId),
}));

/**
 * Certificates - signing certificates
 */
export const certificates = sqliteTable('certificates', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(),
  publicKey: text('public_key').notNull(),
  fingerprint: text('fingerprint').notNull().unique(),
  algorithm: text('algorithm').notNull().default('RSA-SHA256'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  developerIdx: index('cert_developer_idx').on(table.developerId),
}));

/**
 * Reviews - app review queue
 */
export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull().references(() => versions.id),
  reviewerId: text('reviewer_id').references(() => developers.id), // admin who reviewed
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  notes: text('notes'), // reviewer notes
  rejectionReason: text('rejection_reason'),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }).notNull(),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
}, (table) => ({
  versionIdx: index('review_version_idx').on(table.versionId),
  statusIdx: index('review_status_idx').on(table.status),
}));

// Type exports
export type Developer = typeof developers.$inferSelect;
export type NewDeveloper = typeof developers.$inferInsert;
export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
export type Download = typeof downloads.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
export type Review = typeof reviews.$inferSelect;
