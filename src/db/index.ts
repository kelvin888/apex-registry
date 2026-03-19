/**
 * Database Connection
 *
 * Initializes and exports the database connection
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import * as path from 'node:path';
import * as fs from 'node:fs';

export * from './schema';

let db: ReturnType<typeof drizzle> | null = null;
let sqlite: Database.Database | null = null;

export interface DatabaseConfig {
  path: string;
  verbose?: boolean;
}

/**
 * Initialize the database connection
 */
export function initDatabase(config: DatabaseConfig): ReturnType<typeof drizzle> {
  if (db) {
    return db;
  }

  // Ensure directory exists
  const dir = path.dirname(config.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sqlite = new Database(config.path, {
    verbose: config.verbose ? console.log : undefined,
  });

  // Enable WAL mode for better performance
  sqlite.pragma('journal_mode = WAL');
  // Enforce FK constraints — better-sqlite3 v12 / SQLite 3.51+ enables this by
  // default (SQLITE_DEFAULT_FOREIGN_KEYS=1), but we set it explicitly so the
  // behaviour is defined regardless of the bundled SQLite version.
  sqlite.pragma('foreign_keys = ON');

  db = drizzle(sqlite, { schema });

  return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): ReturnType<typeof drizzle> {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

/**
 * Run database migrations
 */
export function runMigrations(): void {
  if (!sqlite) {
    throw new Error('Database not initialized');
  }

  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS developers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      organization TEXT,
      api_key TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL UNIQUE,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS app_id_idx ON apps(app_id);
    CREATE INDEX IF NOT EXISTS developer_idx ON apps(developer_id);
    CREATE INDEX IF NOT EXISTS status_idx ON apps(status);

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id),
      version TEXT NOT NULL,
      version_code INTEGER NOT NULL,
      changelog TEXT,
      min_host_version TEXT,
      permissions TEXT,
      status TEXT NOT NULL DEFAULT 'uploading',
      package_path TEXT,
      package_size INTEGER,
      package_hash TEXT,
      signature TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      published_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS app_version_idx ON versions(app_id, version);
    CREATE UNIQUE INDEX IF NOT EXISTS app_version_code_idx ON versions(app_id, version_code);

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES versions(id),
      host_app_id TEXT,
      host_version TEXT,
      platform TEXT,
      region TEXT,
      ip_hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS download_version_idx ON downloads(version_id);
    CREATE INDEX IF NOT EXISTS download_date_idx ON downloads(created_at);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      permissions TEXT NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS api_key_developer_idx ON api_keys(developer_id);

    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      algorithm TEXT NOT NULL DEFAULT 'RSA-SHA256',
      is_default INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS cert_developer_idx ON certificates(developer_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES versions(id),
      reviewer_id TEXT REFERENCES developers(id),
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      rejection_reason TEXT,
      submitted_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS review_version_idx ON reviews(version_id);
    CREATE INDEX IF NOT EXISTS review_status_idx ON reviews(status);
  `);

  // Additive migrations — safe to run on existing databases
  const columns = sqlite.pragma('table_info(developers)') as Array<{ name: string }>;
  const hasSupended = columns.some((c) => c.name === 'suspended');
  if (!hasSupended) {
    sqlite.exec(`ALTER TABLE developers ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`);
  }
}
