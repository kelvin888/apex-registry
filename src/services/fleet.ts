/**
 * Fleet & Fuel Service
 *
 * Vehicle management, fuel cards, and fleet transactions for B2B developers.
 */

import { eq, desc, and, sql, sum } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase, fleetVehicles, fuelCards, fleetTransactions } from '../db';

// ─── Vehicles ─────────────────────────────────────────────────────────────────

export async function listVehicles(developerId: string) {
    const db = getDatabase();
    return db
        .select()
        .from(fleetVehicles)
        .where(eq(fleetVehicles.developerId, developerId))
        .orderBy(desc(fleetVehicles.createdAt));
}

export async function getVehicle(developerId: string, vehicleId: string) {
    const db = getDatabase();
    const [vehicle] = await db
        .select()
        .from(fleetVehicles)
        .where(and(eq(fleetVehicles.id, vehicleId), eq(fleetVehicles.developerId, developerId)))
        .limit(1);
    if (!vehicle) throw Object.assign(new Error('Vehicle not found'), { statusCode: 404 });
    return vehicle;
}

export async function createVehicle(
    developerId: string,
    params: {
        plateNumber: string;
        make: string;
        model: string;
        year?: number;
        fuelType?: 'petrol' | 'diesel' | 'electric' | 'hybrid' | 'cng';
        assignedDriverName?: string;
        assignedDriverPhone?: string;
    },
) {
    const db = getDatabase();
    const now = new Date();
    const vehicle = {
        id: nanoid(),
        developerId,
        plateNumber: params.plateNumber.toUpperCase(),
        make: params.make,
        model: params.model,
        year: params.year ?? null,
        fuelType: params.fuelType ?? 'petrol',
        status: 'active' as const,
        assignedDriverName: params.assignedDriverName ?? null,
        assignedDriverPhone: params.assignedDriverPhone ?? null,
        odometer: 0,
        createdAt: now,
        updatedAt: now,
    };
    await db.insert(fleetVehicles).values(vehicle);
    return vehicle;
}

export async function updateVehicle(
    developerId: string,
    vehicleId: string,
    params: Partial<{
        status: 'active' | 'inactive' | 'maintenance';
        assignedDriverName: string;
        assignedDriverPhone: string;
        odometer: number;
    }>,
) {
    await getVehicle(developerId, vehicleId); // ownership check
    const db = getDatabase();
    await db
        .update(fleetVehicles)
        .set({ ...params, updatedAt: new Date() })
        .where(eq(fleetVehicles.id, vehicleId));
    return getVehicle(developerId, vehicleId);
}

// ─── Fuel Cards ───────────────────────────────────────────────────────────────

export async function listFuelCards(developerId: string) {
    const db = getDatabase();
    return db
        .select()
        .from(fuelCards)
        .where(eq(fuelCards.developerId, developerId))
        .orderBy(desc(fuelCards.createdAt));
}

export async function createFuelCard(
    developerId: string,
    params: {
        vehicleId?: string;
        cardNumber: string;
        provider?: string;
        spendLimit?: number;
        currency?: string;
    },
) {
    const db = getDatabase();
    const now = new Date();
    const card = {
        id: nanoid(),
        developerId,
        vehicleId: params.vehicleId ?? null,
        cardNumber: params.cardNumber,
        provider: params.provider ?? 'Apex Fuel',
        balance: 0,
        currency: params.currency ?? 'NGN',
        status: 'active' as const,
        spendLimit: params.spendLimit ?? null,
        createdAt: now,
        updatedAt: now,
    };
    await db.insert(fuelCards).values(card);
    return card;
}

export async function topupFuelCard(developerId: string, cardId: string, amount: number) {
    const db = getDatabase();
    const [card] = await db
        .select()
        .from(fuelCards)
        .where(and(eq(fuelCards.id, cardId), eq(fuelCards.developerId, developerId)))
        .limit(1);
    if (!card) throw Object.assign(new Error('Fuel card not found'), { statusCode: 404 });

    const now = new Date();
    await db.update(fuelCards).set({ balance: card.balance + amount, updatedAt: now }).where(eq(fuelCards.id, cardId));

    // Record card_topup transaction
    await db.insert(fleetTransactions).values({
        id: nanoid(),
        developerId,
        vehicleId: card.vehicleId,
        fuelCardId: cardId,
        type: 'card_topup',
        amount,
        currency: card.currency,
        litres: null,
        pricePerLitre: null,
        station: null,
        location: null,
        odometer: null,
        status: 'completed',
        reference: `FUEL-${nanoid(12)}`,
        createdAt: now,
    });

    return { ...card, balance: card.balance + amount };
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function listTransactions(
    developerId: string,
    params: { vehicleId?: string; limit?: number; offset?: number } = {},
) {
    const db = getDatabase();
    const { vehicleId, limit = 20, offset = 0 } = params;

    const conditions = [eq(fleetTransactions.developerId, developerId)];
    if (vehicleId) conditions.push(eq(fleetTransactions.vehicleId, vehicleId));

    return db
        .select()
        .from(fleetTransactions)
        .where(and(...conditions))
        .orderBy(desc(fleetTransactions.createdAt))
        .limit(limit)
        .offset(offset);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getFleetSummary(developerId: string) {
    const db = getDatabase();

    const [vehicles, cards, txnRows] = await Promise.all([
        db.select({ id: fleetVehicles.id, status: fleetVehicles.status }).from(fleetVehicles).where(eq(fleetVehicles.developerId, developerId)),
        db.select({ id: fuelCards.id, balance: fuelCards.balance, currency: fuelCards.currency }).from(fuelCards).where(eq(fuelCards.developerId, developerId)),
        db.select({ amount: fleetTransactions.amount }).from(fleetTransactions).where(
            and(eq(fleetTransactions.developerId, developerId), eq(fleetTransactions.type, 'fuel'))
        ),
    ]);

    const totalVehicles = vehicles.length;
    const activeVehicles = vehicles.filter((v) => v.status === 'active').length;
    const totalCardBalance = cards.reduce((s, c) => s + c.balance, 0);
    const totalFuelSpend = txnRows.reduce((s, t) => s + t.amount, 0);

    return { totalVehicles, activeVehicles, totalCardBalance, totalFuelSpend, currency: 'NGN' };
}
