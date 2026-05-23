/**
 * Health Service
 *
 * Provider directory, appointment booking, consultations,
 * prescriptions, pharmacy orders, and lab test bookings.
 * Integrates with wallet (payment) + history (receipt) + notifications.
 */

import { eq, and, desc, like, sql, asc, gte, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  healthProviders,
  appointments,
  consultations,
  consultationMessages,
  prescriptions,
  prescriptionItems,
  pharmacyOrders,
  pharmacyOrderItems,
  labTests,
  labBookings,
  wallets,
  walletTransactions,
  ledgerEntries,
  users,
  type HealthProvider,
} from '../db';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// SEED DATA — Nigerian Health Provider Catalog
// =============================================================================

const PROVIDER_SEED: Omit<HealthProvider, 'createdAt' | 'updatedAt'>[] = [
  // Doctors
  { id: 'DOC_GP_001', type: 'doctor', name: 'Dr. Adebayo Okonkwo', specialty: 'general_practice', bio: 'Experienced general practitioner with 12 years in family medicine.', photoUrl: null, qualifications: '["MBBS Lagos","MWACP"]', licenseNumber: 'MDCN-45678', consultationFee: 500000, currency: 'NGN', country: 'NG', city: 'Lagos', address: '15 Broad St, Lagos Island', latitude: '6.4541', longitude: '3.4084', phone: '08012345678', rating: 460, reviewCount: 124, languagesSpoken: '["English","Yoruba"]', gender: 'male', availableNow: true, operatingHours: '{"mon-fri":"08:00-18:00","sat":"09:00-14:00"}', active: true },
  { id: 'DOC_DERM_001', type: 'doctor', name: 'Dr. Ngozi Eze', specialty: 'dermatology', bio: 'Board-certified dermatologist specializing in tropical skin conditions.', photoUrl: null, qualifications: '["MBBS UNN","FMCP Dermatology"]', licenseNumber: 'MDCN-56789', consultationFee: 1000000, currency: 'NGN', country: 'NG', city: 'Lagos', address: '8 Admiralty Way, Lekki', latitude: '6.4281', longitude: '3.4219', phone: '08023456789', rating: 480, reviewCount: 89, languagesSpoken: '["English","Igbo"]', gender: 'female', availableNow: false, operatingHours: '{"mon-fri":"09:00-17:00"}', active: true },
  { id: 'DOC_PED_001', type: 'doctor', name: 'Dr. Amina Ibrahim', specialty: 'pediatrics', bio: 'Pediatrician dedicated to child healthcare and immunization.', photoUrl: null, qualifications: '["MBBS ABU","FMCPaed"]', licenseNumber: 'MDCN-67890', consultationFee: 700000, currency: 'NGN', country: 'NG', city: 'Abuja', address: '22 Wuse 2, Abuja', latitude: '9.0574', longitude: '7.4906', phone: '08034567890', rating: 490, reviewCount: 156, languagesSpoken: '["English","Hausa"]', gender: 'female', availableNow: true, operatingHours: '{"mon-sat":"08:00-18:00"}', active: true },
  { id: 'DOC_MH_001', type: 'doctor', name: 'Dr. Emeka Nwosu', specialty: 'mental_health', bio: 'Clinical psychologist with expertise in anxiety, depression and trauma therapy.', photoUrl: null, qualifications: '["MBBS UPH","MSc Clinical Psychology"]', licenseNumber: 'MDCN-78901', consultationFee: 800000, currency: 'NGN', country: 'NG', city: 'Lagos', address: '5 Allen Avenue, Ikeja', latitude: '6.6018', longitude: '3.3515', phone: '08045678901', rating: 470, reviewCount: 67, languagesSpoken: '["English","Igbo","Pidgin"]', gender: 'male', availableNow: false, operatingHours: '{"mon-fri":"10:00-19:00"}', active: true },
  { id: 'DOC_OBG_001', type: 'doctor', name: 'Dr. Funke Adeyemi', specialty: 'obstetrics_gynecology', bio: 'Experienced OB/GYN with focus on maternal health and family planning.', photoUrl: null, qualifications: '["MBBS Ibadan","FWACS"]', licenseNumber: 'MDCN-89012', consultationFee: 1200000, currency: 'NGN', country: 'NG', city: 'Lagos', address: '33 Victoria Island', latitude: '6.4311', longitude: '3.4207', phone: '08056789012', rating: 495, reviewCount: 201, languagesSpoken: '["English","Yoruba"]', gender: 'female', availableNow: true, operatingHours: '{"mon-fri":"08:00-17:00","sat":"09:00-13:00"}', active: true },
  { id: 'DOC_INT_001', type: 'doctor', name: 'Dr. Chidi Okoro', specialty: 'internal_medicine', bio: 'Internist managing chronic conditions including diabetes and hypertension.', photoUrl: null, qualifications: '["MBBS UNN","FMCP Internal Medicine"]', licenseNumber: 'MDCN-90123', consultationFee: 600000, currency: 'NGN', country: 'NG', city: 'Port Harcourt', address: '10 Aba Road, PH', latitude: '4.8156', longitude: '7.0498', phone: '08067890123', rating: 440, reviewCount: 93, languagesSpoken: '["English","Igbo"]', gender: 'male', availableNow: true, operatingHours: '{"mon-fri":"08:00-16:00"}', active: true },

  // Pharmacies
  { id: 'PHARM_001', type: 'pharmacy', name: 'HealthPlus Pharmacy', specialty: null, bio: 'Nigeria\'s leading retail pharmacy chain with genuine medications.', photoUrl: null, qualifications: null, licenseNumber: 'PCN-11234', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '12A Admiralty Way, Lekki Phase 1', latitude: '6.4320', longitude: '3.4572', phone: '08099001122', rating: 450, reviewCount: 312, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-sat":"08:00-21:00","sun":"10:00-18:00"}', active: true },
  { id: 'PHARM_002', type: 'pharmacy', name: 'MedPlus Pharmacy', specialty: null, bio: 'Nationwide pharmacy network with doorstep delivery.', photoUrl: null, qualifications: null, licenseNumber: 'PCN-22345', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '45 Allen Avenue, Ikeja', latitude: '6.6042', longitude: '3.3521', phone: '08099003344', rating: 430, reviewCount: 245, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-sun":"07:00-22:00"}', active: true },
  { id: 'PHARM_003', type: 'pharmacy', name: 'Alpha Pharmacy', specialty: null, bio: 'Trusted community pharmacy in Abuja.', photoUrl: null, qualifications: null, licenseNumber: 'PCN-33456', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Abuja', address: '8 Aminu Kano Crescent, Wuse 2', latitude: '9.0601', longitude: '7.4892', phone: '08099005566', rating: 420, reviewCount: 98, languagesSpoken: null, gender: null, availableNow: false, operatingHours: '{"mon-sat":"08:00-20:00"}', active: true },

  // Hospitals
  { id: 'HOSP_001', type: 'hospital', name: 'Lagoon Hospital', specialty: null, bio: 'Multi-specialty hospital providing world-class healthcare in Lagos.', photoUrl: null, qualifications: null, licenseNumber: 'HEFAMAA-1001', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '7 Mobolaji Bank Anthony Way, Ikeja', latitude: '6.5937', longitude: '3.3451', phone: '08001234000', rating: 460, reviewCount: 567, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-sun":"00:00-23:59"}', active: true },
  { id: 'HOSP_002', type: 'hospital', name: 'Reddington Hospital', specialty: null, bio: 'Premium healthcare services in Victoria Island.', photoUrl: null, qualifications: null, licenseNumber: 'HEFAMAA-1002', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '12 Idowu-Martins, Victoria Island', latitude: '6.4283', longitude: '3.4177', phone: '08001234100', rating: 470, reviewCount: 423, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-sun":"00:00-23:59"}', active: true },

  // Labs
  { id: 'LAB_001', type: 'lab', name: 'Synlab Nigeria', specialty: null, bio: 'International laboratory diagnostics network.', photoUrl: null, qualifications: null, licenseNumber: 'MLSCN-5001', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '54A Adeniyi Jones, Ikeja', latitude: '6.6013', longitude: '3.3502', phone: '08001235000', rating: 475, reviewCount: 289, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-sat":"07:00-18:00"}', active: true },
  { id: 'LAB_002', type: 'lab', name: 'Clina-Lancet Laboratories', specialty: null, bio: 'Quality diagnostic laboratory with fast turnaround.', photoUrl: null, qualifications: null, licenseNumber: 'MLSCN-5002', consultationFee: null, currency: 'NGN', country: 'NG', city: 'Lagos', address: '20 Ozumba Mbadiwe, Victoria Island', latitude: '6.4299', longitude: '3.4211', phone: '08001235100', rating: 465, reviewCount: 198, languagesSpoken: null, gender: null, availableNow: true, operatingHours: '{"mon-fri":"07:00-17:00","sat":"08:00-14:00"}', active: true },
];

// Lab test catalog
const LAB_TEST_SEED = [
  { id: 'LT_FBC', name: 'Full Blood Count (FBC)', category: 'blood_work', description: 'Complete blood cell analysis including RBC, WBC, platelets, haemoglobin.', price: 500000, currency: 'NGN', turnaroundHours: 24, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_MP', name: 'Malaria Parasite Test', category: 'blood_work', description: 'Microscopy and RDT for malaria parasites.', price: 300000, currency: 'NGN', turnaroundHours: 4, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_LFT', name: 'Liver Function Test', category: 'blood_work', description: 'ALT, AST, ALP, bilirubin, albumin, total protein.', price: 800000, currency: 'NGN', turnaroundHours: 48, requiresFasting: true, sampleType: 'blood', active: true },
  { id: 'LT_RFT', name: 'Renal Function Test', category: 'blood_work', description: 'Creatinine, BUN, electrolytes, uric acid.', price: 700000, currency: 'NGN', turnaroundHours: 48, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_LIPID', name: 'Lipid Profile', category: 'blood_work', description: 'Total cholesterol, LDL, HDL, triglycerides.', price: 600000, currency: 'NGN', turnaroundHours: 48, requiresFasting: true, sampleType: 'blood', active: true },
  { id: 'LT_FBS', name: 'Fasting Blood Sugar', category: 'blood_work', description: 'Fasting glucose measurement for diabetes screening.', price: 200000, currency: 'NGN', turnaroundHours: 12, requiresFasting: true, sampleType: 'blood', active: true },
  { id: 'LT_HBA1C', name: 'HbA1c (Glycated Haemoglobin)', category: 'blood_work', description: '3-month average blood sugar level.', price: 1000000, currency: 'NGN', turnaroundHours: 48, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_URINE', name: 'Urinalysis', category: 'urinalysis', description: 'Physical, chemical, and microscopic examination of urine.', price: 300000, currency: 'NGN', turnaroundHours: 12, requiresFasting: false, sampleType: 'urine', active: true },
  { id: 'LT_WIDAL', name: 'Widal Test', category: 'blood_work', description: 'Typhoid fever screening.', price: 400000, currency: 'NGN', turnaroundHours: 24, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_HIV', name: 'HIV Screening', category: 'blood_work', description: 'HIV 1 & 2 antibody test (confidential).', price: 500000, currency: 'NGN', turnaroundHours: 24, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_HEPATITIS', name: 'Hepatitis B & C Panel', category: 'blood_work', description: 'HBsAg and Anti-HCV screening.', price: 800000, currency: 'NGN', turnaroundHours: 24, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_GENOTYPE', name: 'Genotype (Haemoglobin Electrophoresis)', category: 'blood_work', description: 'AA, AS, SS genotype determination.', price: 500000, currency: 'NGN', turnaroundHours: 48, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_PSA', name: 'PSA (Prostate Specific Antigen)', category: 'blood_work', description: 'Prostate cancer screening marker.', price: 600000, currency: 'NGN', turnaroundHours: 48, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_THYROID', name: 'Thyroid Function Test', category: 'blood_work', description: 'TSH, T3, T4 hormone levels.', price: 1200000, currency: 'NGN', turnaroundHours: 72, requiresFasting: false, sampleType: 'blood', active: true },
  { id: 'LT_XRAY', name: 'Chest X-Ray', category: 'imaging', description: 'PA and lateral chest radiograph.', price: 1500000, currency: 'NGN', turnaroundHours: 4, requiresFasting: false, sampleType: null, active: true },
  { id: 'LT_ULTRASOUND', name: 'Abdominal Ultrasound', category: 'imaging', description: 'Ultrasound scan of abdominal organs.', price: 2000000, currency: 'NGN', turnaroundHours: 4, requiresFasting: true, sampleType: null, active: true },
];

/**
 * Seed health providers and lab tests into the database
 */
export async function seedHealthData(): Promise<void> {
  const db = getDatabase();
  const now = new Date();

  for (const p of PROVIDER_SEED) {
    const [existing] = await db.select({ id: healthProviders.id }).from(healthProviders)
      .where(eq(healthProviders.id, p.id)).limit(1);
    if (!existing) {
      await db.insert(healthProviders).values({ ...p, createdAt: now, updatedAt: now });
    }
  }

  for (const t of LAB_TEST_SEED) {
    const [existing] = await db.select({ id: labTests.id }).from(labTests)
      .where(eq(labTests.id, t.id)).limit(1);
    if (!existing) {
      await db.insert(labTests).values(t);
    }
  }
}

// =============================================================================
// SPECIALTIES
// =============================================================================

const SPECIALTIES = [
  { id: 'general_practice', name: 'General Practice', icon: '🩺' },
  { id: 'dermatology', name: 'Dermatology', icon: '🧴' },
  { id: 'pediatrics', name: 'Pediatrics', icon: '👶' },
  { id: 'mental_health', name: 'Mental Health', icon: '🧠' },
  { id: 'obstetrics_gynecology', name: 'Obstetrics & Gynecology', icon: '🤰' },
  { id: 'internal_medicine', name: 'Internal Medicine', icon: '💊' },
  { id: 'ophthalmology', name: 'Ophthalmology', icon: '👁️' },
  { id: 'dentistry', name: 'Dentistry', icon: '🦷' },
  { id: 'orthopedics', name: 'Orthopedics', icon: '🦴' },
  { id: 'cardiology', name: 'Cardiology', icon: '❤️' },
];

export function getSpecialties() {
  return SPECIALTIES;
}

// =============================================================================
// PROVIDERS
// =============================================================================

export async function getProviders(opts: {
  type?: string;
  specialty?: string;
  city?: string;
  country?: string;
  availableNow?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = getDatabase();
  const conditions: any[] = [eq(healthProviders.active, true)];

  if (opts.type) conditions.push(eq(healthProviders.type, opts.type as any));
  if (opts.specialty) conditions.push(eq(healthProviders.specialty, opts.specialty));
  if (opts.city) conditions.push(eq(healthProviders.city, opts.city));
  if (opts.country) conditions.push(eq(healthProviders.country, opts.country));
  if (opts.availableNow) conditions.push(eq(healthProviders.availableNow, true));
  if (opts.search) conditions.push(like(healthProviders.name, `%${opts.search}%`));

  const providers = await db.select().from(healthProviders)
    .where(and(...conditions))
    .orderBy(desc(healthProviders.rating))
    .limit(opts.limit || 20)
    .offset(opts.offset || 0);

  return providers;
}

export async function getProvider(id: string) {
  const db = getDatabase();
  const [row] = await db.select().from(healthProviders)
    .where(eq(healthProviders.id, id)).limit(1);
  return row ?? null;
}

// =============================================================================
// APPOINTMENTS
// =============================================================================

export async function bookAppointment(data: {
  patientId: string;
  providerId: string;
  type: 'consultation' | 'lab_test' | 'follow_up';
  scheduledAt: number; // timestamp ms
  notes?: string;
}) {
  const db = getDatabase();
  const now = new Date();

  const [provider] = await db.select().from(healthProviders)
    .where(eq(healthProviders.id, data.providerId)).limit(1);
  if (!provider) throw new Error('Provider not found');

  const fee = provider.consultationFee || 0;

  // Debit wallet
  const [wallet] = await db.select().from(wallets)
    .where(eq(wallets.userId, data.patientId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < fee) throw new Error('Insufficient balance');

  const appointmentId = nanoid();
  const txRef = `APT-${nanoid(12)}`;

  await db.update(wallets).set({
    balance: wallet.balance - fee,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: fee,
    currency: wallet.currency,
    description: `Medical appointment: ${provider.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ appointmentId, providerId: provider.id }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: fee,
    balanceAfter: wallet.balance - fee,
    createdAt: now,
  });

  await db.insert(appointments).values({
    id: appointmentId,
    patientId: data.patientId,
    providerId: data.providerId,
    type: data.type,
    scheduledAt: new Date(data.scheduledAt),
    consultationFee: fee,
    currency: wallet.currency,
    transactionRef: txRef,
    notes: data.notes || null,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
  });

  // Receipt
  const receiptId = await createReceipt({
    userId: data.patientId,
    vertical: 'health',
    type: 'appointment',
    amount: fee,
    currency: wallet.currency,
    description: `Appointment: ${provider.name}`,
    counterparty: provider.name,
    status: 'completed',
    sourceRef: txRef,
    metadata: { appointmentId, providerName: provider.name, providerType: provider.type, scheduledAt: data.scheduledAt },
  });

  // Notification
  await createNotification({
    userId: data.patientId,
    type: 'transactional',
    title: 'Appointment Confirmed',
    body: `Your appointment with ${provider.name} is confirmed for ${new Date(data.scheduledAt).toLocaleDateString('en-NG')}.`,
    metadata: { appointmentId, receiptId },
  });

  return { appointmentId, transactionRef: txRef, receiptId, fee };
}

export async function getAppointments(patientId: string, status?: string) {
  const db = getDatabase();
  const conditions: any[] = [eq(appointments.patientId, patientId)];
  if (status) conditions.push(eq(appointments.status, status as any));

  return db.select({
    appointment: appointments,
    providerName: healthProviders.name,
    providerType: healthProviders.type,
    providerSpecialty: healthProviders.specialty,
  }).from(appointments)
    .innerJoin(healthProviders, eq(appointments.providerId, healthProviders.id))
    .where(and(...conditions))
    .orderBy(desc(appointments.scheduledAt));
}

export async function getAppointment(id: string) {
  const db = getDatabase();
  const [row] = await db.select({
    appointment: appointments,
    providerName: healthProviders.name,
    providerType: healthProviders.type,
    providerSpecialty: healthProviders.specialty,
    providerPhone: healthProviders.phone,
  }).from(appointments)
    .innerJoin(healthProviders, eq(appointments.providerId, healthProviders.id))
    .where(eq(appointments.id, id)).limit(1);
  return row ?? null;
}

export async function cancelAppointment(appointmentId: string, userId: string, reason?: string) {
  const db = getDatabase();
  const now = new Date();

  const [apt] = await db.select().from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.patientId, userId))).limit(1);
  if (!apt) throw new Error('Appointment not found');
  if (apt.status === 'completed' || apt.status === 'cancelled') {
    throw new Error('Cannot cancel this appointment');
  }

  // Refund to wallet
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (wallet && apt.consultationFee > 0) {
    await db.update(wallets).set({
      balance: wallet.balance + apt.consultationFee,
      updatedAt: now,
    }).where(eq(wallets.id, wallet.id));

    const txId = nanoid();
    await db.insert(walletTransactions).values({
      id: txId,
      walletId: wallet.id,
      type: 'refund',
      amount: apt.consultationFee,
      currency: apt.currency,
      description: `Refund: Cancelled appointment`,
      reference: `REF-${nanoid(12)}`,
      status: 'completed',
      metadata: JSON.stringify({ appointmentId }),
      createdAt: now,
    });

    await db.insert(ledgerEntries).values({
      id: nanoid(),
      transactionId: txId,
      walletId: wallet.id,
      entryType: 'credit',
      amount: apt.consultationFee,
      balanceAfter: wallet.balance + apt.consultationFee,
      createdAt: now,
    });
  }

  await db.update(appointments).set({
    status: 'cancelled',
    cancellationReason: reason || null,
    updatedAt: now,
  }).where(eq(appointments.id, appointmentId));

  await createNotification({
    userId,
    type: 'transactional',
    title: 'Appointment Cancelled',
    body: `Your appointment has been cancelled. Refund of ${apt.consultationFee / 100} ${apt.currency} credited.`,
    metadata: { appointmentId },
  });

  return { refunded: apt.consultationFee };
}

// =============================================================================
// CONSULTATIONS
// =============================================================================

export async function startConsultation(appointmentId: string, userId: string) {
  const db = getDatabase();
  const now = new Date();

  const [apt] = await db.select().from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.patientId, userId))).limit(1);
  if (!apt) throw new Error('Appointment not found');
  if (apt.status !== 'confirmed') throw new Error('Appointment not in a startable state');

  const consultationId = nanoid();

  await db.insert(consultations).values({
    id: consultationId,
    appointmentId,
    patientId: userId,
    providerId: apt.providerId,
    status: 'active',
    startedAt: now,
  });

  await db.update(appointments).set({
    status: 'in_progress',
    updatedAt: now,
  }).where(eq(appointments.id, appointmentId));

  return { consultationId };
}

export async function sendMessage(data: {
  consultationId: string;
  senderId: string;
  senderRole: 'patient' | 'doctor';
  type: 'text' | 'image' | 'voice_note' | 'file';
  content: string;
  mediaUrl?: string;
}) {
  const db = getDatabase();
  const msgId = nanoid();

  await db.insert(consultationMessages).values({
    id: msgId,
    consultationId: data.consultationId,
    senderId: data.senderId,
    senderRole: data.senderRole,
    type: data.type,
    content: data.content,
    mediaUrl: data.mediaUrl || null,
    createdAt: new Date(),
  });

  return { messageId: msgId };
}

export async function getMessages(consultationId: string) {
  const db = getDatabase();
  return db.select().from(consultationMessages)
    .where(eq(consultationMessages.consultationId, consultationId))
    .orderBy(asc(consultationMessages.createdAt));
}

export async function endConsultation(consultationId: string, summary?: string) {
  const db = getDatabase();
  const now = new Date();

  const [consultation] = await db.select().from(consultations)
    .where(eq(consultations.id, consultationId)).limit(1);
  if (!consultation) throw new Error('Consultation not found');

  await db.update(consultations).set({
    status: 'ended',
    endedAt: now,
    summary: summary || null,
  }).where(eq(consultations.id, consultationId));

  await db.update(appointments).set({
    status: 'completed',
    updatedAt: now,
  }).where(eq(appointments.id, consultation.appointmentId));

  return { ended: true };
}

// =============================================================================
// PRESCRIPTIONS
// =============================================================================

export async function createPrescription(data: {
  consultationId: string;
  providerId: string;
  diagnosis: string;
  notes?: string;
  items: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    quantity: number;
    notes?: string;
  }>;
}) {
  const db = getDatabase();
  const now = new Date();

  const [consultation] = await db.select().from(consultations)
    .where(eq(consultations.id, data.consultationId)).limit(1);
  if (!consultation) throw new Error('Consultation not found');

  const prescriptionId = nanoid();

  await db.insert(prescriptions).values({
    id: prescriptionId,
    consultationId: data.consultationId,
    patientId: consultation.patientId,
    providerId: data.providerId,
    diagnosis: data.diagnosis,
    notes: data.notes || null,
    status: 'active',
    createdAt: now,
  });

  for (const item of data.items) {
    await db.insert(prescriptionItems).values({
      id: nanoid(),
      prescriptionId,
      medicineName: item.medicineName,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration,
      quantity: item.quantity,
      notes: item.notes || null,
    });
  }

  const receiptId = await createReceipt({
    userId: consultation.patientId,
    vertical: 'health',
    type: 'prescription',
    amount: 0,
    currency: 'NGN',
    description: `Prescription: ${data.diagnosis}`,
    status: 'completed',
    sourceRef: prescriptionId,
    metadata: { prescriptionId, diagnosis: data.diagnosis, itemCount: data.items.length },
  });

  await db.update(prescriptions).set({ receiptId }).where(eq(prescriptions.id, prescriptionId));

  await createNotification({
    userId: consultation.patientId,
    type: 'system',
    title: 'New Prescription',
    body: `Dr. prescribed ${data.items.length} medication(s) for ${data.diagnosis}. Tap to view or order from pharmacy.`,
    metadata: { prescriptionId, receiptId },
  });

  return { prescriptionId, receiptId };
}

export async function getPrescription(id: string) {
  const db = getDatabase();
  const [rx] = await db.select().from(prescriptions)
    .where(eq(prescriptions.id, id)).limit(1);
  if (!rx) return null;

  const items = await db.select().from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, id));

  return { ...rx, items };
}

export async function getPatientPrescriptions(patientId: string) {
  const db = getDatabase();
  return db.select({
    prescription: prescriptions,
    providerName: healthProviders.name,
  }).from(prescriptions)
    .innerJoin(healthProviders, eq(prescriptions.providerId, healthProviders.id))
    .where(eq(prescriptions.patientId, patientId))
    .orderBy(desc(prescriptions.createdAt));
}

// =============================================================================
// PHARMACY ORDERS
// =============================================================================

export async function createPharmacyOrder(data: {
  patientId: string;
  pharmacyId: string;
  prescriptionId?: string;
  deliveryMethod: 'pickup' | 'delivery';
  deliveryAddress?: string;
  items: Array<{ medicineName: string; quantity: number; unitPrice: number }>;
}) {
  const db = getDatabase();
  const now = new Date();

  const subtotal = data.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const deliveryFee = data.deliveryMethod === 'delivery' ? 150000 : 0; // ₦1,500 delivery
  const total = subtotal + deliveryFee;

  // Debit wallet
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, data.patientId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < total) throw new Error('Insufficient balance');

  const orderId = nanoid();
  const txRef = `PHARM-${nanoid(12)}`;

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
    description: `Pharmacy order`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ orderId }),
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

  await db.insert(pharmacyOrders).values({
    id: orderId,
    patientId: data.patientId,
    pharmacyId: data.pharmacyId,
    prescriptionId: data.prescriptionId || null,
    deliveryMethod: data.deliveryMethod,
    deliveryAddress: data.deliveryAddress || null,
    subtotal,
    deliveryFee,
    total,
    currency: wallet.currency,
    transactionRef: txRef,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
  });

  for (const item of data.items) {
    await db.insert(pharmacyOrderItems).values({
      id: nanoid(),
      orderId,
      medicineName: item.medicineName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.unitPrice * item.quantity,
    });
  }

  // Mark prescription as fulfilled if provided
  if (data.prescriptionId) {
    await db.update(prescriptions).set({ status: 'fulfilled' })
      .where(eq(prescriptions.id, data.prescriptionId));
  }

  const receiptId = await createReceipt({
    userId: data.patientId,
    vertical: 'health',
    type: 'pharmacy_order',
    amount: total,
    currency: wallet.currency,
    description: 'Pharmacy Order',
    status: 'completed',
    sourceRef: txRef,
    metadata: { orderId, itemCount: data.items.length, deliveryMethod: data.deliveryMethod },
  });

  await db.update(pharmacyOrders).set({ receiptId }).where(eq(pharmacyOrders.id, orderId));

  await createNotification({
    userId: data.patientId,
    type: 'transactional',
    title: 'Pharmacy Order Confirmed',
    body: `Your order of ${data.items.length} item(s) has been confirmed. ${data.deliveryMethod === 'delivery' ? 'Delivery on the way!' : 'Ready for pickup.'}`,
    metadata: { orderId, receiptId },
  });

  return { orderId, transactionRef: txRef, receiptId, total };
}

export async function getPharmacyOrder(orderId: string) {
  const db = getDatabase();
  const [order] = await db.select({
    order: pharmacyOrders,
    pharmacyName: healthProviders.name,
  }).from(pharmacyOrders)
    .innerJoin(healthProviders, eq(pharmacyOrders.pharmacyId, healthProviders.id))
    .where(eq(pharmacyOrders.id, orderId)).limit(1);
  if (!order) return null;

  const items = await db.select().from(pharmacyOrderItems)
    .where(eq(pharmacyOrderItems.orderId, orderId));

  return { ...order, items };
}

export async function getPatientOrders(patientId: string) {
  const db = getDatabase();
  return db.select({
    order: pharmacyOrders,
    pharmacyName: healthProviders.name,
  }).from(pharmacyOrders)
    .innerJoin(healthProviders, eq(pharmacyOrders.pharmacyId, healthProviders.id))
    .where(eq(pharmacyOrders.patientId, patientId))
    .orderBy(desc(pharmacyOrders.createdAt));
}

export async function updateOrderStatus(orderId: string, status: string) {
  const db = getDatabase();
  await db.update(pharmacyOrders).set({
    status: status as any,
    updatedAt: new Date(),
  }).where(eq(pharmacyOrders.id, orderId));
}

// =============================================================================
// LAB TESTS & BOOKINGS
// =============================================================================

export async function getLabTests(category?: string) {
  const db = getDatabase();
  const conditions: any[] = [eq(labTests.active, true)];
  if (category) conditions.push(eq(labTests.category, category));

  return db.select().from(labTests)
    .where(and(...conditions))
    .orderBy(asc(labTests.name));
}

export async function bookLabTest(data: {
  patientId: string;
  labId: string;
  testId: string;
  scheduledAt: number; // timestamp ms
  prescriptionId?: string;
}) {
  const db = getDatabase();
  const now = new Date();

  const [test] = await db.select().from(labTests).where(eq(labTests.id, data.testId)).limit(1);
  if (!test) throw new Error('Test not found');

  const [lab] = await db.select().from(healthProviders)
    .where(and(eq(healthProviders.id, data.labId), eq(healthProviders.type, 'lab'))).limit(1);
  if (!lab) throw new Error('Lab not found');

  // Debit wallet
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, data.patientId)).limit(1);
  if (!wallet) throw new Error('Wallet not found');
  if (wallet.balance < test.price) throw new Error('Insufficient balance');

  const bookingId = nanoid();
  const txRef = `LAB-${nanoid(12)}`;

  await db.update(wallets).set({
    balance: wallet.balance - test.price,
    updatedAt: now,
  }).where(eq(wallets.id, wallet.id));

  const txId = nanoid();
  await db.insert(walletTransactions).values({
    id: txId,
    walletId: wallet.id,
    type: 'payment',
    amount: test.price,
    currency: wallet.currency,
    description: `Lab test: ${test.name}`,
    reference: txRef,
    status: 'completed',
    metadata: JSON.stringify({ bookingId, testId: test.id }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values({
    id: nanoid(),
    transactionId: txId,
    walletId: wallet.id,
    entryType: 'debit',
    amount: test.price,
    balanceAfter: wallet.balance - test.price,
    createdAt: now,
  });

  await db.insert(labBookings).values({
    id: bookingId,
    patientId: data.patientId,
    labId: data.labId,
    testId: data.testId,
    prescriptionId: data.prescriptionId || null,
    status: 'booked',
    scheduledAt: new Date(data.scheduledAt),
    amount: test.price,
    currency: wallet.currency,
    transactionRef: txRef,
    createdAt: now,
    updatedAt: now,
  });

  const receiptId = await createReceipt({
    userId: data.patientId,
    vertical: 'health',
    type: 'lab_test',
    amount: test.price,
    currency: wallet.currency,
    description: `Lab Test: ${test.name}`,
    counterparty: lab.name,
    status: 'completed',
    sourceRef: txRef,
    metadata: { bookingId, testName: test.name, labName: lab.name, scheduledAt: data.scheduledAt },
  });

  await db.update(labBookings).set({ receiptId }).where(eq(labBookings.id, bookingId));

  await createNotification({
    userId: data.patientId,
    type: 'transactional',
    title: 'Lab Test Booked',
    body: `${test.name} at ${lab.name} on ${new Date(data.scheduledAt).toLocaleDateString('en-NG')}.${test.requiresFasting ? ' Remember: Fasting required!' : ''}`,
    metadata: { bookingId, receiptId },
  });

  return { bookingId, transactionRef: txRef, receiptId, amount: test.price };
}

export async function getPatientLabBookings(patientId: string) {
  const db = getDatabase();
  return db.select({
    booking: labBookings,
    testName: labTests.name,
    testCategory: labTests.category,
    labName: healthProviders.name,
  }).from(labBookings)
    .innerJoin(labTests, eq(labBookings.testId, labTests.id))
    .innerJoin(healthProviders, eq(labBookings.labId, healthProviders.id))
    .where(eq(labBookings.patientId, patientId))
    .orderBy(desc(labBookings.createdAt));
}

export async function getLabBooking(bookingId: string) {
  const db = getDatabase();
  const [row] = await db.select({
    booking: labBookings,
    testName: labTests.name,
    testCategory: labTests.category,
    testDescription: labTests.description,
    requiresFasting: labTests.requiresFasting,
    turnaroundHours: labTests.turnaroundHours,
    labName: healthProviders.name,
    labAddress: healthProviders.address,
    labPhone: healthProviders.phone,
  }).from(labBookings)
    .innerJoin(labTests, eq(labBookings.testId, labTests.id))
    .innerJoin(healthProviders, eq(labBookings.labId, healthProviders.id))
    .where(eq(labBookings.id, bookingId)).limit(1);
  return row ?? null;
}
