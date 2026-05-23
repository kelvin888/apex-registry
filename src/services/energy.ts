/**
 * Energy Service
 *
 * Prepaid electricity tokens, solar home system payments,
 * cooking gas cylinder refills, usage tracking.
 * Integrates with wallet (payment) + history (receipt) + notifications.
 */

import { eq, and, desc, like, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  energyProviders,
  savedMeters,
  energyPurchases,
  gasVendors,
  solarDevices,
  wallets,
  walletTransactions,
  ledgerEntries,
  type EnergyProvider,
  type GasVendor,
} from '../db';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// SEED DATA — Nigerian Energy Providers
// =============================================================================

const ELECTRICITY_SEED: Omit<EnergyProvider, 'active'>[] = [
  { id: 'ELEC_IKEDC', name: 'Ikeja Electric (IKEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_EKEDC', name: 'Eko Electric (EKEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_AEDC', name: 'Abuja Electric (AEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_IBEDC', name: 'Ibadan Electric (IBEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_EEDC', name: 'Enugu Electric (EEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_PHED', name: 'Port Harcourt Electric (PHED)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_JED', name: 'Jos Electric (JED)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_KAEDCO', name: 'Kaduna Electric (KAEDCO)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_KEDCO', name: 'Kano Electric (KEDCO)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_BEDC', name: 'Benin Electric (BEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
  { id: 'ELEC_YEDC', name: 'Yola Electric (YEDC)', type: 'electricity', country: 'NG', logo: null, serviceCharge: 10000, vatRate: 750, meterTypes: '["prepaid","postpaid"]' },
];

const SOLAR_SEED: Omit<EnergyProvider, 'active'>[] = [
  { id: 'SOLAR_MKOPA', name: 'M-KOPA Solar', type: 'solar', country: 'NG', logo: null, serviceCharge: 0, vatRate: 0, meterTypes: null },
  { id: 'SOLAR_LUMOS', name: 'Lumos Nigeria', type: 'solar', country: 'NG', logo: null, serviceCharge: 0, vatRate: 0, meterTypes: null },
  { id: 'SOLAR_DLIGHT', name: 'd.light Solar', type: 'solar', country: 'NG', logo: null, serviceCharge: 0, vatRate: 0, meterTypes: null },
];

const GAS_PROVIDER_SEED: Omit<EnergyProvider, 'active'>[] = [
  { id: 'GAS_GENERIC', name: 'LPG Cooking Gas', type: 'gas', country: 'NG', logo: null, serviceCharge: 0, vatRate: 750, meterTypes: null },
];

const GAS_VENDOR_SEED: Omit<GasVendor, 'active'>[] = [
  { id: 'GV_LAGOS_001', name: 'NIPCO Gas Lekki', address: '14 Admiralty Way, Lekki Phase 1', city: 'Lagos', country: 'NG', latitude: '6.4320', longitude: '3.4572', phone: '08031234567', rating: 450, price3kg: 250000, price6kg: 480000, price12kg: 900000, price25kg: 1800000, price50kg: 3500000, deliveryFee: 150000, offersDelivery: true },
  { id: 'GV_LAGOS_002', name: 'Gas Point Ikeja', address: '22 Allen Avenue, Ikeja', city: 'Lagos', country: 'NG', latitude: '6.6018', longitude: '3.3515', phone: '08032345678', rating: 420, price3kg: 240000, price6kg: 460000, price12kg: 870000, price25kg: 1750000, price50kg: 3400000, deliveryFee: 200000, offersDelivery: true },
  { id: 'GV_LAGOS_003', name: 'Total Gas Station VI', address: '5 Adeola Odeku, Victoria Island', city: 'Lagos', country: 'NG', latitude: '6.4283', longitude: '3.4177', phone: '08033456789', rating: 460, price3kg: 260000, price6kg: 500000, price12kg: 950000, price25kg: 1900000, price50kg: 3600000, deliveryFee: 0, offersDelivery: false },
  { id: 'GV_ABUJA_001', name: 'Oando Gas Wuse', address: '10 Aminu Kano Crescent, Wuse 2', city: 'Abuja', country: 'NG', latitude: '9.0601', longitude: '7.4892', phone: '08034567890', rating: 440, price3kg: 230000, price6kg: 440000, price12kg: 850000, price25kg: 1700000, price50kg: 3300000, deliveryFee: 100000, offersDelivery: true },
  { id: 'GV_ABUJA_002', name: 'Gas Hub Garki', address: '18 Nnamdi Azikiwe St, Garki', city: 'Abuja', country: 'NG', latitude: '9.0380', longitude: '7.4891', phone: '08035678901', rating: 410, price3kg: 220000, price6kg: 430000, price12kg: 830000, price25kg: 1680000, price50kg: 3250000, deliveryFee: 150000, offersDelivery: true },
  { id: 'GV_PH_001', name: 'Shell Gas PH', address: '33 Aba Road, Port Harcourt', city: 'Port Harcourt', country: 'NG', latitude: '4.8156', longitude: '7.0498', phone: '08036789012', rating: 430, price3kg: 235000, price6kg: 450000, price12kg: 860000, price25kg: 1720000, price50kg: 3350000, deliveryFee: 100000, offersDelivery: true },
];

// =============================================================================
// SEED FUNCTIONS
// =============================================================================

export async function seedEnergyProviders() {
  const db = getDatabase();
  const existing = await db.select({ id: energyProviders.id }).from(energyProviders);
  if (existing.length > 0) return;

  for (const p of [...ELECTRICITY_SEED, ...SOLAR_SEED, ...GAS_PROVIDER_SEED]) {
    await db.insert(energyProviders).values({ ...p, active: true });
  }
}

export async function seedGasVendors() {
  const db = getDatabase();
  const existing = await db.select({ id: gasVendors.id }).from(gasVendors);
  if (existing.length > 0) return;

  for (const v of GAS_VENDOR_SEED) {
    await db.insert(gasVendors).values({ ...v, active: true });
  }
}

// =============================================================================
// PROVIDERS
// =============================================================================

export async function getProviders(type?: 'electricity' | 'solar' | 'gas') {
  const db = getDatabase();
  if (type) {
    return db.select().from(energyProviders)
      .where(and(eq(energyProviders.type, type), eq(energyProviders.active, true)));
  }
  return db.select().from(energyProviders).where(eq(energyProviders.active, true));
}

export async function getProvider(id: string) {
  const db = getDatabase();
  const [row] = await db.select().from(energyProviders).where(eq(energyProviders.id, id)).limit(1);
  return row ?? null;
}

// =============================================================================
// METER VALIDATION (Simulated)
// =============================================================================

export function validateMeter(data: { providerId: string; meterNumber: string; meterType: string }) {
  // In production, this would call the DISCO's API via an aggregator (e.g. Interswitch, BuyPower)
  // For demo, simulate validation based on meter number format
  const meterNum = data.meterNumber.replace(/\s/g, '');
  if (meterNum.length < 11 || meterNum.length > 13) {
    throw new Error('Invalid meter number. Must be 11-13 digits.');
  }

  // Simulate customer lookup
  const lastDigit = parseInt(meterNum.slice(-1), 10);
  const names = [
    'Adebayo Okonkwo', 'Ngozi Eze', 'Amina Ibrahim', 'Emeka Nwosu',
    'Funke Adeyemi', 'Chidi Okoro', 'Fatima Bello', 'Olumide Taiwo',
    'Chioma Nwankwo', 'Hassan Musa',
  ];
  const addresses = [
    '15 Broad St, Lagos Island', '8 Admiralty Way, Lekki', '22 Wuse 2, Abuja',
    '5 Allen Avenue, Ikeja', '33 Victoria Island', '10 Aba Road, PH',
    '7 Garki, Abuja', '12 GRA, Benin', '4 Sabon Gari, Kano', '9 Jimeta, Yola',
  ];

  return {
    valid: true,
    meterNumber: meterNum,
    customerName: names[lastDigit],
    address: addresses[lastDigit],
    meterType: data.meterType,
    tariffClass: lastDigit % 2 === 0 ? 'R2 - Residential' : 'C1 - Commercial',
    outstandingBalance: 0,
  };
}

// =============================================================================
// ELECTRICITY PURCHASE
// =============================================================================

export async function purchaseElectricity(data: {
  userId: string;
  providerId: string;
  meterNumber: string;
  meterType: string;
  customerName: string;
  amount: number;
}) {
  const db = getDatabase();
  const now = new Date();

  const [provider] = await db.select().from(energyProviders)
    .where(and(eq(energyProviders.id, data.providerId), eq(energyProviders.type, 'electricity'))).limit(1);
  if (!provider) throw new Error('Electricity provider not found');

  // Calculate charges
  const serviceCharge = provider.serviceCharge;
  const vat = Math.round((data.amount * provider.vatRate) / 10000);
  const total = data.amount + serviceCharge + vat;

  // Wallet check & debit
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, data.userId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < total) throw new Error('Insufficient balance');

  const purchaseId = nanoid();
  const txRef = `ELEC-${nanoid(12)}`;

  await db.update(wallets).set({
    balance: wallet.balance - total,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: total,
    currency: wallet.currency,
    description: `Electricity: ${provider.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ purchaseId }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: total,
    balanceAfter: wallet.balance - total,
    createdAt: now,
  });

  // Generate simulated token
  const token = generateElectricityToken();
  const kwhRate = 6862; // ₦68.62 per kWh (Band A rate, in kobo)
  const units = (data.amount / kwhRate).toFixed(1);

  await db.insert(energyPurchases).values({
    id: purchaseId,
    userId: data.userId,
    providerId: data.providerId,
    type: 'electricity',
    meterNumber: data.meterNumber,
    meterType: data.meterType,
    customerName: data.customerName,
    amount: data.amount,
    serviceCharge,
    vat,
    total,
    currency: wallet.currency,
    token,
    units: `${units} kWh`,
    tariffClass: 'R2 - Residential',
    status: 'completed',
    transactionRef: txRef,
    createdAt: now,
  });

  const receiptId = await createReceipt({
    userId: data.userId,
    vertical: 'energy',
    type: 'electricity',
    amount: total,
    currency: wallet.currency,
    description: `Electricity token: ${provider.name}`,
    counterparty: provider.name,
    status: 'completed',
    sourceRef: txRef,
    metadata: { purchaseId, meterNumber: data.meterNumber, token, units },
  });

  await db.update(energyPurchases).set({ receiptId }).where(eq(energyPurchases.id, purchaseId));

  await createNotification({
    userId: data.userId,
    type: 'transactional',
    title: 'Electricity Token Received',
    body: `Token: ${token} | ${units} kWh for meter ${data.meterNumber}`,
    metadata: { purchaseId, receiptId, token },
  });

  return { purchaseId, transactionRef: txRef, receiptId, token, units: `${units} kWh`, total };
}

function generateElectricityToken(): string {
  // Standard Nigerian prepaid tokens are 20 digits
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(String(Math.floor(1000 + Math.random() * 9000)));
  }
  segments.push(String(Math.floor(10000 + Math.random() * 90000)));
  return segments.join('-'); // e.g. 1234-5678-9012-3456-78901
}

// =============================================================================
// SAVED METERS
// =============================================================================

export async function getSavedMeters(userId: string, type?: string) {
  const db = getDatabase();
  const conditions = [eq(savedMeters.userId, userId)];
  if (type) conditions.push(eq(savedMeters.type, type as any));
  return db.select().from(savedMeters).where(and(...conditions)).orderBy(desc(savedMeters.createdAt));
}

export async function saveMeter(data: {
  userId: string;
  providerId: string;
  type: 'electricity' | 'solar' | 'gas';
  meterNumber: string;
  meterType?: string;
  customerName?: string;
  address?: string;
  alias?: string;
}) {
  const db = getDatabase();

  // Check for duplicate
  const [existing] = await db.select().from(savedMeters)
    .where(and(
      eq(savedMeters.userId, data.userId),
      eq(savedMeters.meterNumber, data.meterNumber),
      eq(savedMeters.providerId, data.providerId),
    )).limit(1);
  if (existing) throw new Error('Meter already saved');

  const id = nanoid();
  await db.insert(savedMeters).values({
    id,
    userId: data.userId,
    providerId: data.providerId,
    type: data.type,
    meterNumber: data.meterNumber,
    meterType: data.meterType ?? null,
    customerName: data.customerName ?? null,
    address: data.address ?? null,
    alias: data.alias ?? null,
    createdAt: new Date(),
  });

  return { id };
}

export async function deleteSavedMeter(userId: string, meterId: string) {
  const db = getDatabase();
  const [meter] = await db.select().from(savedMeters)
    .where(and(eq(savedMeters.id, meterId), eq(savedMeters.userId, userId))).limit(1);
  if (!meter) throw new Error('Saved meter not found');

  await db.delete(savedMeters).where(eq(savedMeters.id, meterId));
  return { deleted: true };
}

// =============================================================================
// PURCHASE HISTORY
// =============================================================================

export async function getPurchaseHistory(userId: string, type?: string, limit = 20, offset = 0) {
  const db = getDatabase();
  const conditions = [eq(energyPurchases.userId, userId)];
  if (type) conditions.push(eq(energyPurchases.type, type as any));

  const rows = await db.select().from(energyPurchases)
    .where(and(...conditions))
    .orderBy(desc(energyPurchases.createdAt))
    .limit(limit).offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(energyPurchases)
    .where(and(...conditions));

  return { purchases: rows, total: count, limit, offset };
}

export async function getPurchase(userId: string, purchaseId: string) {
  const db = getDatabase();
  const [row] = await db.select().from(energyPurchases)
    .where(and(eq(energyPurchases.id, purchaseId), eq(energyPurchases.userId, userId))).limit(1);
  return row ?? null;
}

// =============================================================================
// SOLAR HOME SYSTEMS
// =============================================================================

export async function registerSolarDevice(data: {
  userId: string;
  providerId: string;
  deviceSerial: string;
  deviceModel?: string;
  totalCost: number;
}) {
  const db = getDatabase();
  const now = new Date();

  const [provider] = await db.select().from(energyProviders)
    .where(and(eq(energyProviders.id, data.providerId), eq(energyProviders.type, 'solar'))).limit(1);
  if (!provider) throw new Error('Solar provider not found');

  const [existing] = await db.select().from(solarDevices)
    .where(eq(solarDevices.deviceSerial, data.deviceSerial)).limit(1);
  if (existing) throw new Error('Device already registered');

  const id = nanoid();
  await db.insert(solarDevices).values({
    id,
    userId: data.userId,
    providerId: data.providerId,
    deviceSerial: data.deviceSerial,
    deviceModel: data.deviceModel ?? null,
    totalCost: data.totalCost,
    totalPaid: 0,
    currency: 'NGN',
    activeUntil: null,
    status: 'locked',
    createdAt: now,
    updatedAt: now,
  });

  return { deviceId: id };
}

export async function getSolarDevices(userId: string) {
  const db = getDatabase();
  return db.select().from(solarDevices).where(eq(solarDevices.userId, userId));
}

export async function getSolarDevice(userId: string, deviceId: string) {
  const db = getDatabase();
  const [row] = await db.select().from(solarDevices)
    .where(and(eq(solarDevices.id, deviceId), eq(solarDevices.userId, userId))).limit(1);
  return row ?? null;
}

export async function paySolar(data: {
  userId: string;
  deviceId: string;
  amount: number;
}) {
  const db = getDatabase();
  const now = new Date();

  const [device] = await db.select().from(solarDevices)
    .where(and(eq(solarDevices.id, data.deviceId), eq(solarDevices.userId, data.userId))).limit(1);
  if (!device) throw new Error('Solar device not found');
  if (device.status === 'owned') throw new Error('Device already fully paid');

  const [provider] = await db.select().from(energyProviders).where(eq(energyProviders.id, device.providerId)).limit(1);
  if (!provider) throw new Error('Provider not found');

  // Wallet check & debit
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, data.userId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < data.amount) throw new Error('Insufficient balance');

  const purchaseId = nanoid();
  const txRef = `SOLAR-${nanoid(12)}`;

  await db.update(wallets).set({
    balance: wallet.balance - data.amount,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: data.amount,
    currency: wallet.currency,
    description: `Solar payment: ${provider.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ purchaseId, deviceSerial: device.deviceSerial }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: data.amount,
    balanceAfter: wallet.balance - data.amount,
    createdAt: now,
  });

  // Calculate days unlocked (~₦500/day for SHS)
  const dailyRate = 50000; // ₦500 per day in kobo
  const daysUnlocked = Math.floor(data.amount / dailyRate);
  const newTotalPaid = device.totalPaid + data.amount;
  const isOwned = newTotalPaid >= device.totalCost;

  // Extend active_until from now or from current expiry if still active
  const baseDate = device.activeUntil && device.activeUntil > now ? device.activeUntil : now;
  const newActiveUntil = new Date(baseDate.getTime() + daysUnlocked * 86400000);

  await db.update(solarDevices).set({
    totalPaid: newTotalPaid,
    activeUntil: isOwned ? null : newActiveUntil,
    status: isOwned ? 'owned' : 'active',
    updatedAt: now,
  }).where(eq(solarDevices.id, device.id));

  await db.insert(energyPurchases).values({
    id: purchaseId,
    userId: data.userId,
    providerId: device.providerId,
    type: 'solar',
    amount: data.amount,
    serviceCharge: 0,
    vat: 0,
    total: data.amount,
    currency: wallet.currency,
    deviceSerial: device.deviceSerial,
    daysUnlocked,
    status: 'completed',
    transactionRef: txRef,
    createdAt: now,
  });

  const receiptId = await createReceipt({
    userId: data.userId,
    vertical: 'energy',
    type: 'solar_payment',
    amount: data.amount,
    currency: wallet.currency,
    description: `Solar SHS: ${provider.name} — ${daysUnlocked} days`,
    counterparty: provider.name,
    status: 'completed',
    sourceRef: txRef,
    metadata: { purchaseId, deviceSerial: device.deviceSerial, daysUnlocked, totalPaid: newTotalPaid, totalCost: device.totalCost },
  });

  await db.update(energyPurchases).set({ receiptId }).where(eq(energyPurchases.id, purchaseId));

  await createNotification({
    userId: data.userId,
    type: 'transactional',
    title: isOwned ? 'Solar Device — Fully Paid!' : 'Solar Payment Confirmed',
    body: isOwned
      ? `Congratulations! Your ${provider.name} device is now fully yours.`
      : `${daysUnlocked} days unlocked. Device active until ${newActiveUntil.toLocaleDateString('en-NG')}.`,
    metadata: { purchaseId, receiptId, deviceSerial: device.deviceSerial },
  });

  return { purchaseId, transactionRef: txRef, receiptId, daysUnlocked, totalPaid: newTotalPaid, totalCost: device.totalCost, isOwned, activeUntil: isOwned ? null : newActiveUntil };
}

// =============================================================================
// GAS VENDORS & ORDERS
// =============================================================================

export async function getGasVendors(city?: string) {
  const db = getDatabase();
  const conditions = [eq(gasVendors.active, true)];
  if (city) conditions.push(eq(gasVendors.city, city));
  return db.select().from(gasVendors).where(and(...conditions)).orderBy(desc(gasVendors.rating));
}

export async function getGasVendor(id: string) {
  const db = getDatabase();
  const [row] = await db.select().from(gasVendors).where(eq(gasVendors.id, id)).limit(1);
  return row ?? null;
}

const CYLINDER_PRICE_MAP: Record<string, keyof GasVendor> = {
  '3kg': 'price3kg',
  '6kg': 'price6kg',
  '12.5kg': 'price12kg',
  '25kg': 'price25kg',
  '50kg': 'price50kg',
};

export async function orderGas(data: {
  userId: string;
  vendorId: string;
  cylinderSize: string;
  deliveryMethod: 'pickup' | 'delivery';
  deliveryAddress?: string;
}) {
  const db = getDatabase();
  const now = new Date();

  const [vendor] = await db.select().from(gasVendors).where(eq(gasVendors.id, data.vendorId)).limit(1);
  if (!vendor) throw new Error('Gas vendor not found');

  const priceKey = CYLINDER_PRICE_MAP[data.cylinderSize];
  if (!priceKey) throw new Error('Invalid cylinder size. Use: 3kg, 6kg, 12.5kg, 25kg, or 50kg');

  const gasPrice = vendor[priceKey] as number | null;
  if (!gasPrice) throw new Error(`${data.cylinderSize} cylinder not available at this vendor`);

  if (data.deliveryMethod === 'delivery' && !vendor.offersDelivery) {
    throw new Error('This vendor does not offer delivery');
  }

  const deliveryFee = data.deliveryMethod === 'delivery' ? (vendor.deliveryFee ?? 0) : 0;
  const [gasProvider] = await db.select().from(energyProviders).where(eq(energyProviders.id, 'GAS_GENERIC')).limit(1);
  if (!gasProvider) throw new Error('Gas provider config not found');
  const vat = Math.round((gasPrice * gasProvider.vatRate) / 10000);
  const total = gasPrice + deliveryFee + vat;

  // Wallet check & debit
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, data.userId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < total) throw new Error('Insufficient balance');

  const purchaseId = nanoid();
  const txRef = `GAS-${nanoid(12)}`;

  await db.update(wallets).set({
    balance: wallet.balance - total,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: total,
    currency: wallet.currency,
    description: `Gas refill: ${data.cylinderSize} — ${vendor.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ purchaseId }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: total,
    balanceAfter: wallet.balance - total,
    createdAt: now,
  });

  await db.insert(energyPurchases).values({
    id: purchaseId,
    userId: data.userId,
    providerId: 'GAS_GENERIC',
    type: 'gas',
    amount: gasPrice,
    serviceCharge: 0,
    vat,
    total,
    currency: wallet.currency,
    cylinderSize: data.cylinderSize,
    vendorId: data.vendorId,
    deliveryMethod: data.deliveryMethod,
    deliveryAddress: data.deliveryAddress ?? null,
    status: 'completed',
    transactionRef: txRef,
    createdAt: now,
  });

  const receiptId = await createReceipt({
    userId: data.userId,
    vertical: 'energy',
    type: 'gas_refill',
    amount: total,
    currency: wallet.currency,
    description: `Gas refill: ${data.cylinderSize} cylinder`,
    counterparty: vendor.name,
    status: 'completed',
    sourceRef: txRef,
    metadata: { purchaseId, cylinderSize: data.cylinderSize, vendorId: data.vendorId, deliveryMethod: data.deliveryMethod },
  });

  await db.update(energyPurchases).set({ receiptId }).where(eq(energyPurchases.id, purchaseId));

  await createNotification({
    userId: data.userId,
    type: 'transactional',
    title: 'Gas Order Confirmed',
    body: `${data.cylinderSize} cylinder from ${vendor.name}. ${data.deliveryMethod === 'delivery' ? 'Delivery on the way!' : 'Ready for pickup.'}`,
    metadata: { purchaseId, receiptId },
  });

  return { purchaseId, transactionRef: txRef, receiptId, total };
}
