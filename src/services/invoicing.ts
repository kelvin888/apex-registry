/**
 * Collections & Invoicing Service
 *
 * Create, send, and track invoices. Record full or partial payments.
 */

import { eq, desc, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, invoices, invoiceLineItems } from '../db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface CreateInvoiceInput {
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    customerAddress?: string;
    currency?: string;
    taxRate?: number;       // basis points: 750 = 7.5%
    discountAmount?: number;
    notes?: string;
    dueAt?: Date;
    lineItems: LineItemInput[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nextInvoiceNumber(existing: string[]): string {
    const nums = existing
        .map((n) => parseInt(n.replace(/^INV-/, ''), 10))
        .filter((n) => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `INV-${String(next).padStart(5, '0')}`;
}

function buildTotals(lineItems: LineItemInput[], taxRate: number, discountAmount: number) {
    const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
    const taxAmount = Math.floor((subtotal * taxRate) / 10000);
    const total = subtotal + taxAmount - discountAmount;
    return { subtotal, taxAmount, total };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listInvoices(developerId: string, status?: string) {
    const db = getDatabase();
    const conditions = [eq(invoices.developerId, developerId)];
    if (status) conditions.push(eq(invoices.status, status as any));
    return db.select().from(invoices).where(and(...conditions)).orderBy(desc(invoices.createdAt));
}

export async function getInvoice(developerId: string, invoiceId: string) {
    const db = getDatabase();
    const invoice = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.developerId, developerId)))
        .get();
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });

    const lineItems = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));

    return { ...invoice, lineItems };
}

export async function createInvoice(developerId: string, input: CreateInvoiceInput) {
    const db = getDatabase();

    // Generate next sequential invoice number
    const existingNums = (
        await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.developerId, developerId))
    ).map((r) => r.invoiceNumber);
    const invoiceNumber = nextInvoiceNumber(existingNums);

    const taxRate = input.taxRate ?? 0;
    const discountAmount = input.discountAmount ?? 0;
    const { subtotal, taxAmount, total } = buildTotals(input.lineItems, taxRate, discountAmount);

    const now = new Date();
    const invoice = {
        id: nanoid(),
        developerId,
        invoiceNumber,
        customerName: input.customerName,
        customerEmail: input.customerEmail ?? null,
        customerPhone: input.customerPhone ?? null,
        customerAddress: input.customerAddress ?? null,
        currency: input.currency ?? 'NGN',
        subtotal,
        taxRate,
        taxAmount,
        discountAmount,
        total,
        amountPaid: 0,
        status: 'draft' as const,
        notes: input.notes ?? null,
        paymentLink: null,
        issuedAt: null,
        dueAt: input.dueAt ?? null,
        paidAt: null,
        createdAt: now,
        updatedAt: now,
    };

    await db.insert(invoices).values(invoice);

    const lineItemRows = input.lineItems.map((li) => ({
        id: nanoid(),
        invoiceId: invoice.id,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        amount: li.quantity * li.unitPrice,
        createdAt: now,
    }));

    if (lineItemRows.length > 0) {
        await db.insert(invoiceLineItems).values(lineItemRows);
    }

    return { ...invoice, lineItems: lineItemRows };
}

export async function sendInvoice(developerId: string, invoiceId: string) {
    const db = getDatabase();
    const invoice = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.developerId, developerId)))
        .get();
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
    if (invoice.status === 'cancelled') throw Object.assign(new Error('Cannot send a cancelled invoice'), { statusCode: 422 });

    const now = new Date();
    await db.update(invoices)
        .set({
            status: 'sent',
            issuedAt: now,
            paymentLink: `https://pay.apexapp.dev/inv/${invoiceId}`,
            updatedAt: now,
        })
        .where(eq(invoices.id, invoiceId));

    return getInvoice(developerId, invoiceId);
}

export async function recordPayment(
    developerId: string,
    invoiceId: string,
    amountPaid: number,
) {
    const db = getDatabase();
    const invoice = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.developerId, developerId)))
        .get();
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
    if (invoice.status === 'cancelled') throw Object.assign(new Error('Invoice is cancelled'), { statusCode: 422 });
    if (invoice.status === 'paid') throw Object.assign(new Error('Invoice already fully paid'), { statusCode: 422 });

    const newAmountPaid = invoice.amountPaid + amountPaid;
    const now = new Date();
    const newStatus = (newAmountPaid >= invoice.total ? 'paid' : 'partial') as 'paid' | 'partial';

    await db.update(invoices).set({
        amountPaid: newAmountPaid,
        status: newStatus,
        paidAt: newStatus === 'paid' ? now : null,
        updatedAt: now,
    }).where(eq(invoices.id, invoiceId));

    return getInvoice(developerId, invoiceId);
}

export async function cancelInvoice(developerId: string, invoiceId: string) {
    const db = getDatabase();
    const invoice = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.developerId, developerId)))
        .get();
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
    if (invoice.status === 'paid') throw Object.assign(new Error('Cannot cancel a paid invoice'), { statusCode: 422 });

    await db.update(invoices).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getInvoicingSummary(developerId: string) {
    const db = getDatabase();
    const rows = await db.select({
        status: invoices.status,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        currency: invoices.currency,
    }).from(invoices).where(eq(invoices.developerId, developerId));

    const total = rows.length;
    const paid = rows.filter((r) => r.status === 'paid').length;
    const outstanding = rows.filter((r) => ['sent', 'viewed', 'partial', 'overdue'].includes(r.status)).length;
    const draft = rows.filter((r) => r.status === 'draft').length;
    const totalInvoiced = rows.reduce((s, r) => s + r.total, 0);
    const totalCollected = rows.reduce((s, r) => s + r.amountPaid, 0);
    const totalOutstanding = totalInvoiced - totalCollected;

    return { total, paid, outstanding, draft, totalInvoiced, totalCollected, totalOutstanding, currency: 'NGN' };
}
