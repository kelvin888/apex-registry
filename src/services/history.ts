/**
 * History Service — Cross-vertical Transaction History
 *
 * Unified receipt store: every transaction across wallet, credit, and
 * future verticals produces a receipt. Receipts can be queried by
 * vertical, type, date range, and status.
 *
 * All amounts in minor units.
 */

import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, receipts, type NewReceipt } from '../db';

// =============================================================================
// CREATE RECEIPT (called internally by other services)
// =============================================================================

export async function createReceipt(data: {
  userId: string;
  vertical: string;
  type: string;
  amount: number;
  currency: string;
  description: string;
  counterparty?: string;
  status: 'completed' | 'pending' | 'failed' | 'refunded';
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = getDatabase();
  const id = `rcp_${nanoid(16)}`;

  await db.insert(receipts).values({
    id,
    userId: data.userId,
    vertical: data.vertical,
    type: data.type,
    amount: data.amount,
    currency: data.currency,
    description: data.description,
    counterparty: data.counterparty ?? null,
    status: data.status,
    sourceRef: data.sourceRef ?? null,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    createdAt: new Date(),
  });

  return id;
}

// =============================================================================
// QUERY RECEIPTS
// =============================================================================

export async function queryReceipts(
  userId: string,
  params: {
    vertical?: string;
    type?: string;
    status?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
    offset?: number;
  },
) {
  const db = getDatabase();

  const limit = Math.min(params.limit || 20, 100);
  const offset = params.offset || 0;

  const conditions = [eq(receipts.userId, userId)];

  if (params.vertical) {
    conditions.push(eq(receipts.vertical, params.vertical));
  }
  if (params.type) {
    conditions.push(eq(receipts.type, params.type));
  }
  if (params.status) {
    conditions.push(eq(receipts.status, params.status as any));
  }
  if (params.startDate) {
    conditions.push(gte(receipts.createdAt, new Date(params.startDate)));
  }
  if (params.endDate) {
    conditions.push(lte(receipts.createdAt, new Date(params.endDate)));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(receipts)
      .where(where)
      .orderBy(desc(receipts.createdAt))
      .limit(limit)
      .offset(offset)
      .all(),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(receipts)
      .where(where)
      .get(),
  ]);

  const total = countResult?.count ?? 0;

  const mapped = rows.map((r) => ({
    receiptId: r.id,
    vertical: r.vertical,
    type: r.type,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    counterparty: r.counterparty ?? undefined,
    status: r.status,
    timestamp: r.createdAt.getTime(),
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));

  return {
    receipts: mapped,
    total,
    hasMore: offset + limit < total,
  };
}

// =============================================================================
// GET SINGLE RECEIPT
// =============================================================================

export async function getReceipt(userId: string, receiptId: string) {
  const db = getDatabase();

  const row = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.userId, userId)))
    .get();

  if (!row) {
    throw Object.assign(new Error('Receipt not found'), { statusCode: 404 });
  }

  return {
    receiptId: row.id,
    vertical: row.vertical,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    counterparty: row.counterparty ?? undefined,
    status: row.status,
    timestamp: row.createdAt.getTime(),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}
