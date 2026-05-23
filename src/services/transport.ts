/**
 * Transport Ticketing Service
 *
 * Bus/BRT tickets, ferry, rail, and ride-hail aggregation.
 * QR-code tickets with time-bound validity, wallet debit, receipts.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  transportOperators,
  transportRoutes,
  transportSchedules,
  transportTickets,
  ridehailPartners,
  wallets,
  walletTransactions,
  ledgerEntries,
  type TransportOperator,
  type TransportRoute,
  type TransportSchedule,
  type TransportTicket,
  type RidehailPartner,
} from '../db';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// SEED DATA
// =============================================================================

type OperatorSeed = Omit<TransportOperator, 'active'>;
type RouteSeed = Omit<TransportRoute, 'active'>;
type PartnerSeed = Omit<RidehailPartner, 'active' | 'supportsInAppPayment'> & { supportsInAppPayment?: boolean };

const OPERATOR_SEED: OperatorSeed[] = [
  // Lagos BRT / LAMATA
  { id: 'OP_LAGOS_BRT', name: 'Lagos BRT (LAMATA)', type: 'brt', country: 'NG', city: 'Lagos', logo: null, website: 'https://lamata.lagosstate.gov.ng' },
  // Lagos Ferry / LAGFERRY
  { id: 'OP_LAGOS_FERRY', name: 'LAGFERRY', type: 'ferry', country: 'NG', city: 'Lagos', logo: null, website: 'https://lagferry.lagosstate.gov.ng' },
  // Lagos Blue Line (Metro)
  { id: 'OP_LAGOS_METRO', name: 'Lagos Blue Line', type: 'rail', country: 'NG', city: 'Lagos', logo: null, website: 'https://lamata.lagosstate.gov.ng' },
  // Abuja BRT / FCTA
  { id: 'OP_ABUJA_BRT', name: 'Abuja BRT (FCTA)', type: 'brt', country: 'NG', city: 'Abuja', logo: null, website: null },
  // Port Harcourt buses
  { id: 'OP_PHC_BUS', name: 'Port Harcourt Transit', type: 'bus', country: 'NG', city: 'Port Harcourt', logo: null, website: null },
  // Ghana Metro Mass Transit
  { id: 'OP_ACCRA_MMT', name: 'Metro Mass Transit (MMT)', type: 'bus', country: 'GH', city: 'Accra', logo: null, website: null },
  // Nairobi Matatu SACCOS (representative)
  { id: 'OP_NBI_2NK', name: '2NK Matatu SACCO', type: 'bus', country: 'KE', city: 'Nairobi', logo: null, website: null },
];

/** Prices are JSON: { single, return, day_pass, weekly_pass } in minor units (kobo/pesewas/cents) */
const ROUTE_SEED: RouteSeed[] = [
  // Lagos BRT corridors
  {
    id: 'RT_LG_BRT_01',
    operatorId: 'OP_LAGOS_BRT',
    name: 'CMS ↔ Oshodi BRT Corridor',
    origin: 'CMS (Marina)',
    destination: 'Oshodi',
    stops: JSON.stringify(['CMS', 'Leventis', 'Idumota', 'Idumagbo', 'Oshodi']),
    distanceKm: 12,
    durationMins: 35,
    prices: JSON.stringify({ single: 60000, return: 110000, day_pass: 150000, weekly_pass: 650000 }),
    currency: 'NGN',
  },
  {
    id: 'RT_LG_BRT_02',
    operatorId: 'OP_LAGOS_BRT',
    name: 'Oshodi ↔ Mile 12 BRT Corridor',
    origin: 'Oshodi',
    destination: 'Mile 12',
    stops: JSON.stringify(['Oshodi', 'Ikorodu Road', 'Owode', 'Ketu', 'Mile 12']),
    distanceKm: 14,
    durationMins: 40,
    prices: JSON.stringify({ single: 70000, return: 130000, day_pass: 170000, weekly_pass: 750000 }),
    currency: 'NGN',
  },
  {
    id: 'RT_LG_BRT_03',
    operatorId: 'OP_LAGOS_BRT',
    name: 'TBS ↔ Ikorodu Express',
    origin: 'Tafawa Balewa Square (TBS)',
    destination: 'Ikorodu',
    stops: JSON.stringify(['TBS', 'Iddo', 'Yaba', 'Pedro', 'Ikorodu']),
    distanceKm: 36,
    durationMins: 60,
    prices: JSON.stringify({ single: 120000, return: 220000, day_pass: 250000, weekly_pass: 1050000 }),
    currency: 'NGN',
  },
  // Lagos Ferry
  {
    id: 'RT_LG_FERRY_01',
    operatorId: 'OP_LAGOS_FERRY',
    name: 'CMS ↔ Ikorodu Ferry',
    origin: 'CMS Ferry Terminal',
    destination: 'Ikorodu',
    stops: JSON.stringify(['CMS', 'Badore', 'Ikorodu']),
    distanceKm: 30,
    durationMins: 45,
    prices: JSON.stringify({ single: 150000, return: 280000, day_pass: 0, weekly_pass: 0 }),
    currency: 'NGN',
  },
  {
    id: 'RT_LG_FERRY_02',
    operatorId: 'OP_LAGOS_FERRY',
    name: 'CMS ↔ Badore Ferry',
    origin: 'CMS Ferry Terminal',
    destination: 'Badore',
    stops: JSON.stringify(['CMS', 'Badore']),
    distanceKm: 15,
    durationMins: 25,
    prices: JSON.stringify({ single: 100000, return: 190000, day_pass: 0, weekly_pass: 0 }),
    currency: 'NGN',
  },
  // Lagos Blue Line (Rail)
  {
    id: 'RT_LG_METRO_01',
    operatorId: 'OP_LAGOS_METRO',
    name: 'Mile 2 ↔ Marina Blue Line',
    origin: 'Mile 2',
    destination: 'Marina',
    stops: JSON.stringify(['Mile 2', 'National Theatre', 'Orile', 'Iganmu', 'National Theatre', 'Muritala Muhammed Way', 'Marina']),
    distanceKm: 13,
    durationMins: 22,
    prices: JSON.stringify({ single: 100000, return: 180000, day_pass: 220000, weekly_pass: 900000 }),
    currency: 'NGN',
  },
  // Abuja BRT
  {
    id: 'RT_ABJ_BRT_01',
    operatorId: 'OP_ABUJA_BRT',
    name: 'Central ↔ Kubwa BRT',
    origin: 'Area 10 Central',
    destination: 'Kubwa',
    stops: JSON.stringify(['Area 10', 'Utako', 'Jabi', 'Karu', 'Kubwa']),
    distanceKm: 28,
    durationMins: 50,
    prices: JSON.stringify({ single: 80000, return: 150000, day_pass: 180000, weekly_pass: 750000 }),
    currency: 'NGN',
  },
  {
    id: 'RT_ABJ_BRT_02',
    operatorId: 'OP_ABUJA_BRT',
    name: 'Central ↔ Airport Shuttle',
    origin: 'Area 10 Central',
    destination: 'Nnamdi Azikiwe International Airport',
    stops: JSON.stringify(['Area 10', 'Wuse 2', 'Asokoro', 'Airport']),
    distanceKm: 35,
    durationMins: 55,
    prices: JSON.stringify({ single: 150000, return: 280000, day_pass: 0, weekly_pass: 0 }),
    currency: 'NGN',
  },
];

const PARTNER_SEED: PartnerSeed[] = [
  { id: 'RH_BOLT', name: 'Bolt', country: 'NG', appDeepLink: 'bolt://request', webUrl: 'https://bolt.eu', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_UBER', name: 'Uber', country: 'NG', appDeepLink: 'uber://', webUrl: 'https://uber.com', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_INDRIVER', name: 'inDrive', country: 'NG', appDeepLink: 'indriver://', webUrl: 'https://indrive.com', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_RIDA', name: 'Rida', country: 'NG', appDeepLink: null, webUrl: 'https://rida.ng', logoUrl: null, supportsInAppPayment: true },
  { id: 'RH_GOKADA', name: 'Gokada', country: 'NG', appDeepLink: null, webUrl: 'https://gokada.ng', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_BOLT_GH', name: 'Bolt', country: 'GH', appDeepLink: 'bolt://request', webUrl: 'https://bolt.eu', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_UBER_GH', name: 'Uber', country: 'GH', appDeepLink: 'uber://', webUrl: 'https://uber.com', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_BOLT_KE', name: 'Bolt', country: 'KE', appDeepLink: 'bolt://request', webUrl: 'https://bolt.eu', logoUrl: null, supportsInAppPayment: false },
  { id: 'RH_LITTLECAB', name: 'Little Cab', country: 'KE', appDeepLink: null, webUrl: 'https://little.bz', logoUrl: null, supportsInAppPayment: false },
];

export async function seedTransportData(): Promise<void> {
  const db = getDatabase();
  if (!db) return;

  const existing = await db.select({ id: transportOperators.id }).from(transportOperators).limit(1);
  if (existing.length > 0) return;

  for (const op of OPERATOR_SEED) {
    await db.insert(transportOperators).values({ ...op, active: true }).onConflictDoNothing();
  }
  for (const rt of ROUTE_SEED) {
    await db.insert(transportRoutes).values({ ...rt, active: true }).onConflictDoNothing();
  }
  for (const p of PARTNER_SEED) {
    await db.insert(ridehailPartners).values({
      ...p,
      supportsInAppPayment: p.supportsInAppPayment ?? false,
      active: true,
    }).onConflictDoNothing();
  }

  // Seed upcoming schedules (next 8 hours, every 20 min per route)
  const now = Date.now();
  const routes = await db.select().from(transportRoutes).where(eq(transportRoutes.active, true));
  for (const route of routes) {
    const prices: Record<string, number> = JSON.parse(route.prices);
    const interval = 20 * 60 * 1000; // 20 min
    const slots = 24;
    for (let i = 0; i < slots; i++) {
      const dep = new Date(now + i * interval);
      const arr = new Date(dep.getTime() + route.durationMins * 60 * 1000);
      await db.insert(transportSchedules).values({
        id: nanoid(),
        routeId: route.id,
        departureTime: dep,
        arrivalTime: arr,
        capacity: 50,
        availableSeats: 50,
        platform: null,
        status: 'scheduled',
        delayMins: 0,
      }).onConflictDoNothing();
    }
  }
}

// =============================================================================
// QR DATA
// =============================================================================

function buildQrData(params: {
  ticketId: string;
  userId: string;
  routeId: string;
  operatorId: string;
  ticketType: string;
  validUntil: Date;
}): string {
  const payload = JSON.stringify({
    tid: params.ticketId,
    uid: params.userId,
    rid: params.routeId,
    oid: params.operatorId,
    type: params.ticketType,
    exp: params.validUntil.toISOString(),
    nonce: nanoid(8),
  });
  return Buffer.from(payload).toString('base64');
}

function validUntilFor(type: string, from: Date): Date {
  const d = new Date(from);
  switch (type) {
    case 'return':
      d.setHours(d.getHours() + 12);
      break;
    case 'day_pass':
      d.setDate(d.getDate() + 1);
      d.setHours(23, 59, 59, 0);
      break;
    case 'weekly_pass':
      d.setDate(d.getDate() + 7);
      d.setHours(23, 59, 59, 0);
      break;
    default: // single
      d.setHours(d.getHours() + 4);
  }
  return d;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export async function getOperators(city?: string, type?: string) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');
  const rows = await db.select().from(transportOperators).where(eq(transportOperators.active, true));
  return rows.filter(op => {
    if (city && op.city.toLowerCase() !== city.toLowerCase()) return false;
    if (type && op.type !== type) return false;
    return true;
  });
}

export async function getRoutes(operatorId?: string) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');
  let rows = await db.select().from(transportRoutes).where(eq(transportRoutes.active, true));
  if (operatorId) rows = rows.filter(r => r.operatorId === operatorId);
  return rows.map(r => ({
    ...r,
    stops: r.stops ? JSON.parse(r.stops) : [],
    prices: JSON.parse(r.prices),
  }));
}

export async function getSchedules(routeId: string) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');
  const now = new Date();
  const cutoff = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hrs ahead
  const nowSec = Math.floor(now.getTime() / 1000);
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);
  return db
    .select()
    .from(transportSchedules)
    .where(
      and(
        eq(transportSchedules.routeId, routeId),
        sql`${transportSchedules.departureTime} >= ${nowSec}`,
        sql`${transportSchedules.departureTime} <= ${cutoffSec}`,
        sql`${transportSchedules.status} != 'cancelled'`,
      ),
    )
    .orderBy(transportSchedules.departureTime);
}

export async function purchaseTicket(params: {
  userId: string;
  routeId: string;
  scheduleId?: string;
  ticketType: 'single' | 'return' | 'day_pass' | 'weekly_pass';
  adultCount: number;
  childCount?: number;
  walletId: string;
}): Promise<TransportTicket> {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');

  const { userId, routeId, scheduleId, ticketType, adultCount, childCount = 0, walletId } = params;

  // Load route
  const [route] = await db.select().from(transportRoutes).where(eq(transportRoutes.id, routeId)).limit(1);
  if (!route) throw new Error('Route not found');

  const prices: Record<string, number> = JSON.parse(route.prices);
  const unitPrice = prices[ticketType];
  if (!unitPrice) throw new Error(`Ticket type '${ticketType}' not available on this route`);

  // Children ride at 50% fare
  const totalPassengers = adultCount + childCount;
  const total = (adultCount * unitPrice) + Math.floor(childCount * unitPrice * 0.5);

  // Check & debit wallet
  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.userId !== userId) throw new Error('Wallet does not belong to user');
  if ((wallet.balance ?? 0) < total) throw new Error('Insufficient wallet balance');

  const now = new Date();
  const validUntil = validUntilFor(ticketType, now);
  const ticketId = nanoid();
  const transactionRef = `TRX-TKT-${nanoid(10).toUpperCase()}`;

  const qrData = buildQrData({ ticketId, userId, routeId, operatorId: route.operatorId, ticketType, validUntil });

  // Debit wallet
  const newBalance = (wallet.balance ?? 0) - total;
  await db.update(wallets).set({ balance: newBalance, updatedAt: now }).where(eq(wallets.id, walletId));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId,
    type: 'payment',
    amount: total,
    currency: route.currency,
    reference: transactionRef,
    description: `Transport ticket: ${route.name} (${ticketType}) × ${totalPassengers}`,
    status: 'completed',
    metadata: null,
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId,
    entryType: 'debit',
    amount: total,
    balanceAfter: newBalance,
    createdAt: now,
  });

  // Decrement schedule seat count
  if (scheduleId) {
    const [sched] = await db.select().from(transportSchedules).where(eq(transportSchedules.id, scheduleId)).limit(1);
    if (sched) {
      const newSeats = Math.max(0, sched.availableSeats - totalPassengers);
      await db.update(transportSchedules).set({ availableSeats: newSeats }).where(eq(transportSchedules.id, scheduleId));
    }
  }

  // Receipt & notification
  const receiptId = await createReceipt({
    userId,
    vertical: 'transport',
    type: 'payment',
    amount: total,
    currency: route.currency,
    description: `${route.name} — ${ticketType} × ${totalPassengers} passenger${totalPassengers > 1 ? 's' : ''}`,
    counterparty: route.name,
    status: 'completed',
    sourceRef: transactionRef,
    metadata: { routeId, operatorId: route.operatorId, ticketType, adultCount, childCount },
  });

  await createNotification({
    userId,
    type: 'transactional',
    title: 'Ticket Purchased',
    body: `Your ${ticketType.replace('_', ' ')} ticket for ${route.name} is ready. Show QR at boarding.`,
    deepLink: `/transport/my-ticket?id=${ticketId}`,
    metadata: { ticketId },
  });

  const ticket: typeof transportTickets.$inferInsert = {
    id: ticketId,
    userId,
    operatorId: route.operatorId,
    routeId,
    scheduleId: scheduleId ?? null,
    ticketType,
    adultCount,
    childCount,
    unitPrice,
    total,
    currency: route.currency,
    qrData,
    status: 'active',
    validFrom: now,
    validUntil,
    usedAt: null,
    transactionRef,
    receiptId,
    metadata: null,
    createdAt: now,
  };

  await db.insert(transportTickets).values(ticket);

  const [inserted] = await db.select().from(transportTickets).where(eq(transportTickets.id, ticketId)).limit(1);
  return inserted;
}

export async function getMyTickets(userId: string, status?: string) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');

  let rows = await db
    .select()
    .from(transportTickets)
    .where(eq(transportTickets.userId, userId))
    .orderBy(desc(transportTickets.createdAt));

  if (status) rows = rows.filter(t => t.status === status);

  // Auto-expire tickets past validUntil
  const now = new Date();
  const result = [];
  for (const t of rows) {
    if (t.status === 'active' && t.validUntil < now) {
      await db.update(transportTickets).set({ status: 'expired' }).where(eq(transportTickets.id, t.id));
      result.push({ ...t, status: 'expired' as const });
    } else {
      result.push(t);
    }
  }
  return result;
}

export async function getTicket(ticketId: string, userId: string): Promise<TransportTicket> {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');

  const [ticket] = await db.select().from(transportTickets)
    .where(and(eq(transportTickets.id, ticketId), eq(transportTickets.userId, userId)))
    .limit(1);
  if (!ticket) throw new Error('Ticket not found');

  // Auto-expire
  if (ticket.status === 'active' && ticket.validUntil < new Date()) {
    await db.update(transportTickets).set({ status: 'expired' }).where(eq(transportTickets.id, ticketId));
    return { ...ticket, status: 'expired' };
  }
  return ticket;
}

export async function validateTicket(ticketId: string, validatorUserId?: string): Promise<TransportTicket> {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');

  const [ticket] = await db.select().from(transportTickets).where(eq(transportTickets.id, ticketId)).limit(1);
  if (!ticket) throw new Error('Ticket not found');

  const now = new Date();

  if (ticket.status === 'used') throw new Error('Ticket has already been used');
  if (ticket.status === 'expired' || ticket.validUntil < now) throw new Error('Ticket has expired');
  if (ticket.status === 'refunded') throw new Error('Ticket has been refunded');

  await db.update(transportTickets)
    .set({ status: 'used', usedAt: now })
    .where(eq(transportTickets.id, ticketId));

  return { ...ticket, status: 'used', usedAt: now };
}

export async function getPartners(country?: string) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');
  let rows = await db.select().from(ridehailPartners).where(eq(ridehailPartners.active, true));
  if (country) rows = rows.filter(p => p.country === country.toUpperCase());
  return rows;
}

export async function getHistory(userId: string, limit = 20) {
  const db = getDatabase();
  if (!db) throw new Error('Database unavailable');
  return db
    .select()
    .from(transportTickets)
    .where(eq(transportTickets.userId, userId))
    .orderBy(desc(transportTickets.createdAt))
    .limit(limit);
}
