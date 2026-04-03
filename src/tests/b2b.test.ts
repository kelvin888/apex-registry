/**
 * B2B Portal Integration Tests
 *
 * Full-stack coverage of every B2B vertical the portal uses.
 * Uses Fastify's .inject() — no network, in-process, real SQLite DB.
 *
 * Flow: register → login → JWT → call B2B endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FastifyInstance } from 'fastify';
import { createServer } from '../server';
import { closeDatabase } from '../db';
import { type Config } from '../config';

// ─── Test harness ─────────────────────────────────────────────────────────────

let server: FastifyInstance;
let tempDir: string;
let token: string;
let developerId: string;

const CREDS = {
  email: `b2b-test-${Date.now()}@example.com`,
  password: 'Test1234!',
  name: 'B2B Test Developer',
  organization: 'Test Corp',
};

async function inject(
  method: string,
  url: string,
  payload?: unknown,
  auth = true,
) {
  return server.inject({
    method: method as any,
    url,
    payload: payload ?? undefined,
    headers: auth ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-b2b-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  const storagePath = path.join(tempDir, 'packages');

  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    nodeEnv: 'test',
    databasePath: dbPath,
    jwtSecret: 'b2b-test-secret-key-for-testing-only!',
    jwtExpiresIn: '1d',
    storagePath,
    maxPackageSize: 10 * 1024 * 1024,
    rateLimit: 10000,
    rateLimitWindow: 60000,
    corsOrigins: ['*'],
    logLevel: 'error',
  };

  server = await createServer({ config, logger: false });
  await server.ready();

  // Register and capture JWT for all subsequent tests
  const reg = await server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: CREDS,
  });
  expect(reg.statusCode).toBe(200);
  const body = JSON.parse(reg.body);
  token = body.token;
  developerId = body.developer.id;
});

afterAll(async () => {
  await server.close();
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Auth guard sanity ────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('rejects unauthenticated requests to B2B endpoints', async () => {
    const res = await inject('GET', '/api/b2b/wallet', undefined, false);
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid JWT', async () => {
    const res = await inject('GET', '/api/b2b/profile');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.email).toBe(CREDS.email);
  });
});

// ─── Wallet ───────────────────────────────────────────────────────────────────

describe('Wallet', () => {
  it('GET /api/b2b/wallet — returns wallet with zero balance for new account', async () => {
    const res = await inject('GET', '/api/b2b/wallet');
    expect(res.statusCode).toBe(200);
    const wallet = JSON.parse(res.body);
    expect(wallet).toHaveProperty('balance');
    expect(wallet.currency).toMatch(/^[A-Z]{3}$/);
    expect(wallet.status).toBe('active');
  });

  it('POST /api/b2b/wallet/fund — funds the wallet', async () => {
    const res = await inject('POST', '/api/b2b/wallet/fund', {
      amount: 500000,
      currency: 'NGN',
      description: 'Test top-up',
    });
    expect(res.statusCode).toBe(200);
    const tx = JSON.parse(res.body);
    expect(tx.amount).toBe(500000);
    expect(tx.type).toBe('fund');
    expect(tx.status).toBe('completed');
  });

  it('GET /api/b2b/wallet — balance increases after funding', async () => {
    const res = await inject('GET', '/api/b2b/wallet');
    expect(res.statusCode).toBe(200);
    const wallet = JSON.parse(res.body);
    expect(wallet.balance).toBeGreaterThanOrEqual(500000);
  });

  it('GET /api/b2b/wallet/transactions — returns transaction list', async () => {
    const res = await inject('GET', '/api/b2b/wallet/transactions');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Accepts both array and { transactions: [] } shapes
    const txs: unknown[] = Array.isArray(body) ? body : body.transactions ?? body.data ?? [];
    expect(txs.length).toBeGreaterThan(0);
  });

  it('GET /api/b2b/wallet/transactions?limit=1 — respects limit param', async () => {
    const res = await inject('GET', '/api/b2b/wallet/transactions?limit=1');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const txs: unknown[] = Array.isArray(body) ? body : body.transactions ?? body.data ?? [];
    expect(txs.length).toBeLessThanOrEqual(1);
  });

  it('POST /api/b2b/wallet/fund — rejects amount below minimum', async () => {
    const res = await inject('POST', '/api/b2b/wallet/fund', {
      amount: 1,
      currency: 'NGN',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── KYB ─────────────────────────────────────────────────────────────────────

describe('KYB', () => {
  it('GET /api/b2b/kyb — returns initial status', async () => {
    const res = await inject('GET', '/api/b2b/kyb');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('status');
  });

  it('POST /api/b2b/kyb/submit — submits KYB information', async () => {
    const res = await inject('POST', '/api/b2b/kyb/submit', {
      businessName: 'Test Corp Ltd',
      registrationNumber: 'RC123456',
      country: 'NG',
      businessType: 'llc',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('status');
    expect(['pending', 'submitted']).toContain(body.status);
  });

  it('POST /api/b2b/kyb/submit — rejects missing businessName', async () => {
    const res = await inject('POST', '/api/b2b/kyb/submit', {
      registrationNumber: 'RC999',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── Fleet ────────────────────────────────────────────────────────────────────

describe('Fleet', () => {
  let vehicleId: string;
  let fuelCardId: string;

  it('GET /api/b2b/fleet/summary — returns summary KPIs', async () => {
    const res = await inject('GET', '/api/b2b/fleet/summary');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('totalVehicles');
    expect(body).toHaveProperty('totalCardBalance');
  });

  it('POST /api/b2b/fleet/vehicles — registers a vehicle', async () => {
    const res = await inject('POST', '/api/b2b/fleet/vehicles', {
      plateNumber: 'AAA-123-XY',
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      fuelType: 'diesel',
    });
    expect(res.statusCode).toBe(200);
    const vehicle = JSON.parse(res.body);
    expect(vehicle.plateNumber).toBe('AAA-123-XY');
    expect(vehicle.make).toBe('Toyota');
    vehicleId = vehicle.id;
  });

  it('GET /api/b2b/fleet/vehicles — lists vehicles', async () => {
    const res = await inject('GET', '/api/b2b/fleet/vehicles');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const vehicles: unknown[] = Array.isArray(body) ? body : body.vehicles ?? [];
    expect(vehicles.some((v: any) => v.id === vehicleId)).toBe(true);
  });

  it('GET /api/b2b/fleet/vehicles/:id — returns vehicle detail', async () => {
    const res = await inject('GET', `/api/b2b/fleet/vehicles/${vehicleId}`);
    expect(res.statusCode).toBe(200);
    const vehicle = JSON.parse(res.body);
    expect(vehicle.id).toBe(vehicleId);
  });

  it('PATCH /api/b2b/fleet/vehicles/:id — updates vehicle status', async () => {
    const res = await inject('PATCH', `/api/b2b/fleet/vehicles/${vehicleId}`, {
      status: 'maintenance',
    });
    expect(res.statusCode).toBe(200);
    const vehicle = JSON.parse(res.body);
    expect(vehicle.status).toBe('maintenance');
  });

  it('POST /api/b2b/fleet/fuel-cards — issues a fuel card', async () => {
    const res = await inject('POST', '/api/b2b/fleet/fuel-cards', {
      cardNumber: 'FC-9999-0001',
      vehicleId,
      provider: 'TotalEnergies',
      spendLimit: 200000,
      currency: 'NGN',
    });
    expect(res.statusCode).toBe(200);
    const card = JSON.parse(res.body);
    expect(card.cardNumber).toBe('FC-9999-0001');
    fuelCardId = card.id;
  });

  it('GET /api/b2b/fleet/fuel-cards — lists fuel cards', async () => {
    const res = await inject('GET', '/api/b2b/fleet/fuel-cards');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const cards: unknown[] = Array.isArray(body) ? body : body.fuelCards ?? body.cards ?? [];
    expect(cards.some((c: any) => c.id === fuelCardId)).toBe(true);
  });

  it('POST /api/b2b/fleet/fuel-cards/:id/topup — tops up fuel card', async () => {
    const res = await inject('POST', `/api/b2b/fleet/fuel-cards/${fuelCardId}/topup`, {
      amount: 50000,
    });
    expect(res.statusCode).toBe(200);
    const card = JSON.parse(res.body);
    expect(card.balance).toBeGreaterThanOrEqual(50000);
  });

  it('GET /api/b2b/fleet/transactions — returns transaction history', async () => {
    const res = await inject('GET', '/api/b2b/fleet/transactions');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const txs: unknown[] = Array.isArray(body) ? body : body.transactions ?? [];
    expect(Array.isArray(txs)).toBe(true);
  });

  it('POST /api/b2b/fleet/vehicles — rejects missing required fields', async () => {
    const res = await inject('POST', '/api/b2b/fleet/vehicles', {
      make: 'Ford',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── Staff Health ─────────────────────────────────────────────────────────────

describe('Staff Health', () => {
  let planId: string;
  let enrollmentId: string;

  it('GET /api/b2b/health/plans — returns plan catalog', async () => {
    const res = await inject('GET', '/api/b2b/health/plans');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const plans: any[] = body.plans ?? body;
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
    planId = plans[0].id;
  });

  it('GET /api/b2b/health/summary — returns health summary', async () => {
    const res = await inject('GET', '/api/b2b/health/summary');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('totalEmployees');
    expect(body).toHaveProperty('totalClaims');
  });

  it('POST /api/b2b/health/enrollments — enrolls an employee', async () => {
    const res = await inject('POST', '/api/b2b/health/enrollments', {
      planId,
      employeeId: 'EMP-001',
      employeeName: 'Ada Okafor',
      employeeEmail: 'ada@testcorp.com',
      dateOfBirth: '1990-05-15',
      gender: 'female',
    });
    expect(res.statusCode).toBe(201);
    const enrollment = JSON.parse(res.body);
    expect(enrollment.employeeName).toBe('Ada Okafor');
    enrollmentId = enrollment.id;
  });

  it('GET /api/b2b/health/enrollments — lists enrollments', async () => {
    const res = await inject('GET', '/api/b2b/health/enrollments');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const list: unknown[] = body.enrollments ?? body;
    expect(list.some((e: any) => e.id === enrollmentId)).toBe(true);
  });

  it('PATCH /api/b2b/health/enrollments/:id — updates enrollment status', async () => {
    const res = await inject('PATCH', `/api/b2b/health/enrollments/${enrollmentId}`, {
      status: 'suspended',
    });
    expect(res.statusCode).toBe(200);
    const enrollment = JSON.parse(res.body);
    expect(enrollment.status).toBe('suspended');
  });

  it('POST /api/b2b/health/claims — submits a claim', async () => {
    // Re-activate enrollment first
    await inject('PATCH', `/api/b2b/health/enrollments/${enrollmentId}`, { status: 'active' });

    const res = await inject('POST', '/api/b2b/health/claims', {
      enrollmentId,
      claimType: 'outpatient',
      amount: 15000,
      currency: 'NGN',
      providerName: 'Eko Hospital',
      description: 'Consultation and drugs',
    });
    expect(res.statusCode).toBe(201);
    const claim = JSON.parse(res.body);
    expect(claim.claimType).toBe('outpatient');
    expect(['pending', 'under_review']).toContain(claim.status);
  });

  it('GET /api/b2b/health/claims — lists claims', async () => {
    const res = await inject('GET', '/api/b2b/health/claims');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const claims: unknown[] = body.claims ?? body;
    expect(Array.isArray(claims)).toBe(true);
  });

  it('POST /api/b2b/health/enrollments — rejects missing required fields', async () => {
    const res = await inject('POST', '/api/b2b/health/enrollments', {
      planId,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── Cross-border Payments ────────────────────────────────────────────────────

describe('Cross-border Payments', () => {
  let recipientId: string;

  it('GET /api/b2b/crossborder/corridors — returns supported corridors', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/corridors');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const corridors: unknown[] = body.corridors ?? body;
    expect(corridors.length).toBeGreaterThan(0);
    expect((corridors[0] as any)).toHaveProperty('country');
    expect((corridors[0] as any)).toHaveProperty('currency');
  });

  it('GET /api/b2b/crossborder/quote — returns FX quote', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/quote?from=NGN&to=KES&amount=100000');
    expect(res.statusCode).toBe(200);
    const quote = JSON.parse(res.body);
    expect(quote).toHaveProperty('exchangeRate');
    expect(quote).toHaveProperty('receiveAmount');
    expect(quote.sendCurrency).toBe('NGN');
    expect(quote.receiveCurrency).toBe('KES');
  });

  it('GET /api/b2b/crossborder/quote — rejects missing params', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/quote?from=NGN');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('GET /api/b2b/crossborder/summary — returns transfer summary', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/summary');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('completed');
  });

  it('POST /api/b2b/crossborder/recipients — creates a recipient', async () => {
    const res = await inject('POST', '/api/b2b/crossborder/recipients', {
      alias: 'nairobi-supplier',
      fullName: 'Wanjiku Traders Ltd',
      country: 'KE',
      currency: 'KES',
      type: 'bank_account',
      accountNumber: '0123456789',
      bankName: 'KCB Bank',
      bankCode: '01',
    });
    expect(res.statusCode).toBe(201);
    const recipient = JSON.parse(res.body);
    expect(recipient.alias).toBe('nairobi-supplier');
    recipientId = recipient.id;
  });

  it('GET /api/b2b/crossborder/recipients — lists recipients', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/recipients');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const recipients: unknown[] = body.recipients ?? body;
    expect(recipients.some((r: any) => r.id === recipientId)).toBe(true);
  });

  it('POST /api/b2b/crossborder/transfers — initiates a transfer', async () => {
    const res = await inject('POST', '/api/b2b/crossborder/transfers', {
      recipientId,
      sendAmount: 100000,
      sendCurrency: 'NGN',
      receiveCurrency: 'KES',
      recipientName: 'Wanjiku Traders Ltd',
      recipientCountry: 'KE',
      recipientAccount: '0123456789',
      purpose: 'supplier',
      narration: 'Invoice #2026-001',
    });
    expect(res.statusCode).toBe(201);
    const transfer = JSON.parse(res.body);
    expect(transfer).toHaveProperty('reference');
    expect(['pending', 'processing']).toContain(transfer.status);
  });

  it('GET /api/b2b/crossborder/transfers — lists transfers', async () => {
    const res = await inject('GET', '/api/b2b/crossborder/transfers');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const transfers: unknown[] = body.transfers ?? body;
    expect(Array.isArray(transfers)).toBe(true);
  });

  it('DELETE /api/b2b/crossborder/recipients/:id — deletes a recipient', async () => {
    const res = await inject('DELETE', `/api/b2b/crossborder/recipients/${recipientId}`);
    expect(res.statusCode).toBe(204);
  });
});

// ─── Invoicing ────────────────────────────────────────────────────────────────

describe('Invoicing', () => {
  let invoiceId: string;

  it('GET /api/b2b/invoicing/summary — returns KPIs', async () => {
    const res = await inject('GET', '/api/b2b/invoicing/summary');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('total');
  });

  it('POST /api/b2b/invoicing — creates an invoice', async () => {
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await inject('POST', '/api/b2b/invoicing', {
      customerName: 'Acme Nigeria Ltd',
      customerEmail: 'accounts@acme.ng',
      currency: 'NGN',
      taxRate: 7.5,
      dueAt: due,
      lineItems: [
        { description: 'Platform licence Q2', quantity: 1, unitPrice: 250000 },
        { description: 'Support & SLA', quantity: 3, unitPrice: 50000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const invoice = JSON.parse(res.body);
    expect(invoice.customerName).toBe('Acme Nigeria Ltd');
    expect(invoice.status).toBe('draft');
    expect(invoice).toHaveProperty('invoiceNumber');
    invoiceId = invoice.id;
  });

  it('GET /api/b2b/invoicing — lists invoices', async () => {
    const res = await inject('GET', '/api/b2b/invoicing');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const invoices: unknown[] = body.invoices ?? body;
    expect(invoices.some((inv: any) => inv.id === invoiceId)).toBe(true);
  });

  it('GET /api/b2b/invoicing/:id — returns invoice detail', async () => {
    const res = await inject('GET', `/api/b2b/invoicing/${invoiceId}`);
    expect(res.statusCode).toBe(200);
    const invoice = JSON.parse(res.body);
    expect(invoice.id).toBe(invoiceId);
    // Line items should be present
    const items: unknown[] = invoice.lineItems ?? invoice.items ?? [];
    expect(items.length).toBe(2);
  });

  it('POST /api/b2b/invoicing/:id/send — marks invoice as sent', async () => {
    const res = await inject('POST', `/api/b2b/invoicing/${invoiceId}/send`);
    expect(res.statusCode).toBe(200);
    const invoice = JSON.parse(res.body);
    expect(['sent', 'viewed']).toContain(invoice.status);
  });

  it('POST /api/b2b/invoicing/:id/payment — records a partial payment', async () => {
    const res = await inject('POST', `/api/b2b/invoicing/${invoiceId}/payment`, {
      amount: 100000,
    });
    expect(res.statusCode).toBe(200);
    const invoice = JSON.parse(res.body);
    expect(invoice.amountPaid).toBeGreaterThanOrEqual(100000);
    expect(['partial', 'paid']).toContain(invoice.status);
  });

  it('POST /api/b2b/invoicing/:id/cancel — cancels an invoice', async () => {
    // Create a fresh draft to cancel
    const createRes = await inject('POST', '/api/b2b/invoicing', {
      customerName: 'To Cancel Inc',
      currency: 'NGN',
      lineItems: [{ description: 'Item', quantity: 1, unitPrice: 1000 }],
    });
    const { id: cancelId } = JSON.parse(createRes.body);

    const res = await inject('POST', `/api/b2b/invoicing/${cancelId}/cancel`);
    expect(res.statusCode).toBe(204);
  });

  it('POST /api/b2b/invoicing — rejects missing customerName', async () => {
    const res = await inject('POST', '/api/b2b/invoicing', {
      lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('POST /api/b2b/invoicing — rejects empty lineItems', async () => {
    const res = await inject('POST', '/api/b2b/invoicing', {
      customerName: 'Acme',
      lineItems: [],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── Embedded Finance ─────────────────────────────────────────────────────────

describe('Embedded Finance', () => {
  let walletId: string;
  let webhookId: string;

  it('GET /api/b2b/finance/summary — returns KPIs', async () => {
    const res = await inject('GET', '/api/b2b/finance/summary');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('totalWallets');
  });

  it('POST /api/b2b/finance/wallets — creates an embedded wallet', async () => {
    const res = await inject('POST', '/api/b2b/finance/wallets', {
      externalCustomerId: 'cust-001',
      customerName: 'Fatima Aliyu',
      customerEmail: 'fatima@example.com',
      currency: 'NGN',
      tier: 'standard',
    });
    expect(res.statusCode).toBe(201);
    const wallet = JSON.parse(res.body);
    expect(wallet.customerName).toBe('Fatima Aliyu');
    expect(wallet.currency).toBe('NGN');
    walletId = wallet.id;
  });

  it('GET /api/b2b/finance/wallets — lists embedded wallets', async () => {
    const res = await inject('GET', '/api/b2b/finance/wallets');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const wallets: unknown[] = body.wallets ?? body;
    expect(wallets.some((w: any) => w.id === walletId)).toBe(true);
  });

  it('GET /api/b2b/finance/wallets/:id — returns wallet detail', async () => {
    const res = await inject('GET', `/api/b2b/finance/wallets/${walletId}`);
    expect(res.statusCode).toBe(200);
    const wallet = JSON.parse(res.body);
    expect(wallet.id).toBe(walletId);
  });

  it('POST /api/b2b/finance/wallets/:id/credit — credits the wallet', async () => {
    const res = await inject('POST', `/api/b2b/finance/wallets/${walletId}/credit`, {
      amount: 100000,
      currency: 'NGN',
      reference: `REF-${Date.now()}`,
      description: 'Initial load',
    });
    expect(res.statusCode).toBe(201);
    const txn = JSON.parse(res.body);
    expect(txn.balanceAfter).toBeGreaterThanOrEqual(100000);
  });

  it('POST /api/b2b/finance/wallets/:id/debit — debits the wallet', async () => {
    const res = await inject('POST', `/api/b2b/finance/wallets/${walletId}/debit`, {
      amount: 20000,
      currency: 'NGN',
      reference: `REF-DEBIT-${Date.now()}`,
      description: 'Service fee',
    });
    expect(res.statusCode).toBe(201);
    const txn = JSON.parse(res.body);
    expect(txn.balanceAfter).toBeGreaterThanOrEqual(0);
  });

  it('PATCH /api/b2b/finance/wallets/:id/status — freezes the wallet', async () => {
    const res = await inject('PATCH', `/api/b2b/finance/wallets/${walletId}/status`, {
      status: 'frozen',
    });
    expect(res.statusCode).toBe(200);
    const wallet = JSON.parse(res.body);
    expect(wallet.status).toBe('frozen');
  });

  it('GET /api/b2b/finance/wallets/:id/transactions — lists transactions', async () => {
    const res = await inject('GET', `/api/b2b/finance/wallets/${walletId}/transactions`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const txs: unknown[] = body.transactions ?? body;
    expect(Array.isArray(txs)).toBe(true);
  });

  it('GET /api/b2b/finance/webhooks/events — returns supported event types', async () => {
    const res = await inject('GET', '/api/b2b/finance/webhooks/events');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const events: unknown[] = body.events ?? body;
    expect(events.length).toBeGreaterThan(0);
  });

  it('POST /api/b2b/finance/webhooks — registers a webhook', async () => {
    const res = await inject('POST', '/api/b2b/finance/webhooks', {
      url: 'https://example.com/webhook',
      events: ['wallet.credited', 'wallet.debited'],
      secret: 'whsec_test1234567890',
    });
    expect(res.statusCode).toBe(201);
    const webhook = JSON.parse(res.body);
    expect(webhook.url).toBe('https://example.com/webhook');
    webhookId = webhook.id;
  });

  it('GET /api/b2b/finance/webhooks — lists webhooks', async () => {
    const res = await inject('GET', '/api/b2b/finance/webhooks');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const hooks: unknown[] = body.webhooks ?? body;
    expect(hooks.some((h: any) => h.id === webhookId)).toBe(true);
  });

  it('DELETE /api/b2b/finance/webhooks/:id — deletes a webhook', async () => {
    const res = await inject('DELETE', `/api/b2b/finance/webhooks/${webhookId}`);
    expect(res.statusCode).toBe(204);
  });
});
