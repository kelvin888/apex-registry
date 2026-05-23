/**
 * Package Signing Tests
 *
 * Verifies that the server enforces signature verification during package upload:
 *  - unsigned packages are accepted (signing is optional)
 *  - validly signed packages (with a registered cert) are accepted
 *  - packages with an unregistered signing key are rejected
 *  - packages with a tampered file (signature no longer matches) are rejected
 *  - packages with a malformed signature.sig are rejected
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { initDatabase, closeDatabase, runMigrations } from '../db';
import * as authService from '../services/auth';
import * as appsService from '../services/apps';
import * as versionsService from '../services/versions';
import { type Config } from '../config';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/apex_test';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Replicates the CLI's calculateContentHash logic for test fixture generation. */
function buildContentHash(files: Array<{ name: string; data: Buffer }>): string {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const hash = crypto.createHash('sha256');
  for (const { name, data } of sorted) {
    hash.update(name);
    hash.update(data);
  }
  return hash.digest('hex');
}

interface SignedPackageOpts {
  privateKey: string;
  publicKey?: string;   // only for embedding certificate field (optional)
  keyId?: string;
  files?: Array<{ name: string; data: Buffer }>;
  tamperAfterSigning?: boolean; // swap a file's content after computing the sig
}

function makeSignedPackage(opts: SignedPackageOpts): Buffer {
  const appJs = Buffer.from('console.log("signed-app");', 'utf-8');
  const files: Array<{ name: string; data: Buffer }> = opts.files ?? [
    { name: 'app.js', data: appJs },
  ];

  const contentHash = buildContentHash(files);

  const signer = crypto.createSign('SHA256');
  signer.update(contentHash);
  signer.end();
  const signature = signer.sign(opts.privateKey, 'base64');

  const sigData = {
    algorithm: 'RSA-SHA256',
    keyId: opts.keyId ?? 'test-key',
    timestamp: new Date().toISOString(),
    contentHash,
    signature,
  };

  const manifest = {
    version: '1.0.0',
    formatVersion: 1,
    info: { appId: 'com.example.sigtest', name: 'Signing Test App', version: '1.0.0', versionCode: 1 },
    pages: [{ path: 'pages/index/index', isEntry: true }],
    permissions: ['storage'],
    signature: { algorithm: 'RSA-SHA256', keyId: opts.keyId ?? 'test-key' },
  };

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));
  zip.addFile('signature.sig', Buffer.from(JSON.stringify(sigData), 'utf-8'));

  if (opts.tamperAfterSigning) {
    // Inject a file AFTER the signature was computed — hash won't match
    zip.addFile('app.js', Buffer.from('console.log("TAMPERED");', 'utf-8'));
  } else {
    for (const { name, data } of files) {
      zip.addFile(name, data);
    }
  }

  return zip.toBuffer();
}

function makeUnsignedPackage(): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(
    JSON.stringify({
      version: '1.0.0',
      formatVersion: 1,
      info: { appId: 'com.example.sigtest', name: 'Unsigned Test App', version: '1.0.0', versionCode: 1 },
      pages: [{ path: 'pages/index/index', isEntry: true }],
      permissions: ['storage'],
    }),
    'utf-8',
  ));
  zip.addFile('app.js', Buffer.from('console.log("unsigned");', 'utf-8'));
  return zip.toBuffer();
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('Package Signing Enforcement', () => {
  let tempDir: string;
  let developerId: string;
  let appId: string;
  let config: Config;

  // RSA-2048 key pair generated once for the suite
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  // A second, unregistered key pair for negative tests
  const { privateKey: otherPrivateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-signing-test-'));
    const storagePath = path.join(tempDir, 'packages');

    initDatabase(TEST_DATABASE_URL);
    await runMigrations();

    config = {
      host: '0.0.0.0',
      port: 0,
      nodeEnv: 'test',
      databaseUrl: TEST_DATABASE_URL,
      jwtSecret: 'test-secret-for-signing-tests!',
      jwtExpiresIn: '1d',
      storagePath,
      maxPackageSize: 10 * 1024 * 1024,
      rateLimit: 10000,
      rateLimitWindow: 60000,
      corsOrigins: ['*'],
      logLevel: 'error',
    };

    const { developer } = await authService.registerDeveloper({
      email: `signing-test-${Date.now()}@example.com`,
      password: 'Test1234!',
      name: 'Signing Test Developer',
    });
    developerId = developer.id;

    const app = await appsService.createApp(developerId, {
      appId: 'com.example.sigtest',
      name: 'Signing Test App',
    });
    appId = app.id;
  });

  afterEach(async () => {
    await closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── 1. Unsigned package is accepted ──────────────────────────────────────────

  it('accepts an unsigned package', async () => {
    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    const result = await versionsService.uploadPackage(
      version.id, developerId,
      { buffer: makeUnsignedPackage(), filename: 'package.map' },
      config,
    );
    expect(result.status).toBe('ready');
    expect(result.signature).toBeNull();
  });

  // ── 2. Valid signed package + registered cert is accepted ─────────────────────

  it('accepts a signed package when cert is registered', async () => {
    // Register the developer's public key
    await authService.registerCertificate(developerId, 'CI Key', publicKey);

    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    const result = await versionsService.uploadPackage(
      version.id, developerId,
      { buffer: makeSignedPackage({ privateKey }), filename: 'package.map' },
      config,
    );
    expect(result.status).toBe('ready');
    expect(result.signature).not.toBeNull();
    const stored = JSON.parse(result.signature!);
    expect(stored.algorithm).toBe('RSA-SHA256');
  });

  // ── 3. Signed with unregistered key is rejected ───────────────────────────────

  it('rejects a package signed with an unregistered key', async () => {
    // Developer has NO certificates registered
    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    await expect(
      versionsService.uploadPackage(
        version.id, developerId,
        { buffer: makeSignedPackage({ privateKey }), filename: 'package.map' },
        config,
      ),
    ).rejects.toThrow('no certificates are registered');
  });

  // ── 4. Signed with wrong key (different cert registered) is rejected ──────────

  it('rejects a package signed with a key that does not match any registered cert', async () => {
    // Register the FIRST key but sign with the OTHER key
    await authService.registerCertificate(developerId, 'CI Key', publicKey);

    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    await expect(
      versionsService.uploadPackage(
        version.id, developerId,
        { buffer: makeSignedPackage({ privateKey: otherPrivateKey }), filename: 'package.map' },
        config,
      ),
    ).rejects.toThrow('signature does not match any registered certificate');
  });

  // ── 5. Tampered package (file added after signing) is rejected ────────────────

  it('rejects a package whose contents were modified after signing', async () => {
    await authService.registerCertificate(developerId, 'CI Key', publicKey);

    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    await expect(
      versionsService.uploadPackage(
        version.id, developerId,
        {
          buffer: makeSignedPackage({ privateKey, tamperAfterSigning: true }),
          filename: 'package.map',
        },
        config,
      ),
    ).rejects.toThrow('signature does not match any registered certificate');
  });

  // ── 6. Malformed signature.sig is rejected ────────────────────────────────────

  it('rejects a package with malformed signature.sig', async () => {
    await authService.registerCertificate(developerId, 'CI Key', publicKey);

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(
      JSON.stringify({
        version: '1.0.0',
        formatVersion: 1,
        info: { appId: 'com.example.sigtest', name: 'Test', version: '1.0.0', versionCode: 1 },
        pages: [{ path: 'pages/index/index', isEntry: true }],
        permissions: [],
      }),
      'utf-8',
    ));
    zip.addFile('app.js', Buffer.from('console.log("test");', 'utf-8'));
    zip.addFile('signature.sig', Buffer.from('not valid json {{{{', 'utf-8'));

    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    await expect(
      versionsService.uploadPackage(
        version.id, developerId,
        { buffer: zip.toBuffer(), filename: 'package.map' },
        config,
      ),
    ).rejects.toThrow('signature.sig is not valid JSON');
  });

  // ── 7. Accepted with multiple registered certs (any-of semantics) ─────────────

  it('accepts a signed package when multiple certs are registered and one matches', async () => {
    // Register ANOTHER key first, then the correct one
    const { publicKey: otherPublicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    await authService.registerCertificate(developerId, 'Old Key', otherPublicKey);
    await authService.registerCertificate(developerId, 'Current Key', publicKey);

    const version = await versionsService.createVersion(appId, developerId, { version: '1.0.0' });
    const result = await versionsService.uploadPackage(
      version.id, developerId,
      { buffer: makeSignedPackage({ privateKey }), filename: 'package.map' },
      config,
    );
    expect(result.status).toBe('ready');
  });
});
