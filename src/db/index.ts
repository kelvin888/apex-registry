/**
 * Database Connection — PostgreSQL via drizzle-orm/postgres-js
 *
 * Initializes and exports the database connection.
 * All operations are async (PostgreSQL is non-blocking).
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export * from './schema';

let db: ReturnType<typeof drizzle> | null = null;
let sql: ReturnType<typeof postgres> | null = null;

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Initialize the database connection.
 * Safe to call multiple times — returns the existing connection after the first call.
 */
export function initDatabase(connectionString: string): DB {
  if (db) {
    return db as DB;
  }

  sql = postgres(connectionString, {
    max: 10,          // connection pool size
    idle_timeout: 20, // close idle connections after 20s
    connect_timeout: 10,
  });

  db = drizzle(sql, { schema });

  return db as DB;
}

/**
 * Get the database instance.
 * Throws if initDatabase has not been called yet.
 */
export function getDatabase(): DB {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db as DB;
}

/**
 * Close the database connection pool.
 */
export async function closeDatabase(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
  }
}

/**
 * Run database migrations — creates all tables if they do not exist.
 * Idempotent: safe to run on every startup.
 */
export async function runMigrations(): Promise<void> {
  if (!sql) {
    throw new Error('Database not initialized');
  }

  // ── Core registry tables ─────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS developers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      organization TEXT,
      api_key TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      suspended BOOLEAN NOT NULL DEFAULT false,
      verified BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL UNIQUE,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      platform TEXT NOT NULL DEFAULT 'mobile',
      status TEXT NOT NULL DEFAULT 'draft',
      is_public BOOLEAN NOT NULL DEFAULT false,
      supported_countries TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS developer_idx ON apps(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS status_idx ON apps(status)`;

  await sql`
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
      created_at TIMESTAMPTZ NOT NULL,
      published_at TIMESTAMPTZ,
      UNIQUE(app_id, version),
      UNIQUE(app_id, version_code)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES versions(id),
      host_app_id TEXT,
      host_version TEXT,
      platform TEXT,
      region TEXT,
      ip_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS download_version_idx ON downloads(version_id)`;
  await sql`CREATE INDEX IF NOT EXISTS download_date_idx ON downloads(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      permissions TEXT NOT NULL,
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS api_key_developer_idx ON api_keys(developer_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      algorithm TEXT NOT NULL DEFAULT 'RSA-SHA256',
      is_default BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS cert_developer_idx ON certificates(developer_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES versions(id),
      reviewer_id TEXT REFERENCES developers(id),
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      rejection_reason TEXT,
      submitted_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS review_version_idx ON reviews(version_id)`;
  await sql`CREATE INDEX IF NOT EXISTS review_status_idx ON reviews(status)`;

  // ── Identity tables ───────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      avatar TEXT,
      country TEXT NOT NULL DEFAULT 'NG',
      kyc_level TEXT NOT NULL DEFAULT 'none',
      kyb_level TEXT NOT NULL DEFAULT 'none',
      is_business_user BOOLEAN NOT NULL DEFAULT false,
      suspended BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS user_country_idx ON users(country)`;

  await sql`
    CREATE TABLE IF NOT EXISTS kyc_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      target_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      country TEXT NOT NULL,
      national_id_type TEXT,
      national_id_hash TEXT,
      document_type TEXT,
      verified_fields TEXT,
      next_step TEXT,
      rejection_reason TEXT,
      reviewer_id TEXT REFERENCES developers(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS kyc_user_idx ON kyc_records(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS kyc_status_idx ON kyc_records(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS kyb_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      target_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      country TEXT NOT NULL,
      business_name TEXT,
      business_type TEXT,
      registration_number TEXT,
      registration_doc_type TEXT,
      tax_id TEXT,
      verified_fields TEXT,
      next_step TEXT,
      rejection_reason TEXT,
      reviewer_id TEXT REFERENCES developers(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS kyb_user_idx ON kyb_records(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS kyb_status_idx ON kyb_records(status)`;

  // ── Wallet tables ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance BIGINT NOT NULL DEFAULT 0,
      available_balance BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id, currency)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS wallet_status_idx ON wallets(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      description TEXT,
      counterparty TEXT,
      reference TEXT NOT NULL UNIQUE,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS txn_wallet_idx ON wallet_transactions(wallet_id)`;
  await sql`CREATE INDEX IF NOT EXISTS txn_type_idx ON wallet_transactions(type)`;
  await sql`CREATE INDEX IF NOT EXISTS txn_status_idx ON wallet_transactions(status)`;
  await sql`CREATE INDEX IF NOT EXISTS txn_date_idx ON wallet_transactions(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES wallet_transactions(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      entry_type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ledger_txn_idx ON ledger_entries(transaction_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ledger_wallet_idx ON ledger_entries(wallet_id)`;

  // ── Credit Engine ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS credit_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) UNIQUE,
      score INTEGER NOT NULL,
      band TEXT NOT NULL,
      max_eligible_amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      factors TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS loan_offers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      product TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      interest_rate DOUBLE PRECISION NOT NULL,
      tenor_days INTEGER NOT NULL,
      total_repayment BIGINT NOT NULL,
      monthly_repayment BIGINT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS offer_user_idx ON loan_offers(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS offer_status_idx ON loan_offers(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      offer_id TEXT NOT NULL REFERENCES loan_offers(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      product TEXT NOT NULL,
      amount BIGINT NOT NULL,
      outstanding_balance BIGINT NOT NULL,
      currency TEXT NOT NULL,
      interest_rate DOUBLE PRECISION NOT NULL,
      total_repayment BIGINT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'approved',
      disbursement_ref TEXT,
      disbursed_at TIMESTAMPTZ,
      due_date TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS loan_user_idx ON loans(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS loan_status_idx ON loans(status)`;
  await sql`CREATE INDEX IF NOT EXISTS loan_due_date_idx ON loans(due_date)`;

  await sql`
    CREATE TABLE IF NOT EXISTS loan_repayments (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL REFERENCES loans(id),
      amount BIGINT NOT NULL,
      type TEXT NOT NULL,
      wallet_transaction_id TEXT REFERENCES wallet_transactions(id),
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS repayment_loan_idx ON loan_repayments(loan_id)`;

  // ── Receipts ──────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      vertical TEXT NOT NULL,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      counterparty TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      source_ref TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS receipt_user_idx ON receipts(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS receipt_vertical_idx ON receipts(vertical)`;
  await sql`CREATE INDEX IF NOT EXISTS receipt_type_idx ON receipts(type)`;
  await sql`CREATE INDEX IF NOT EXISTS receipt_status_idx ON receipts(status)`;
  await sql`CREATE INDEX IF NOT EXISTS receipt_date_idx ON receipts(created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS receipt_source_ref_idx ON receipts(source_ref)`;

  // ── Notifications ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS push_token_user_idx ON push_tokens(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      push_enabled BOOLEAN NOT NULL DEFAULT true,
      in_app_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id, category)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      deep_link TEXT,
      source_app_id TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS notif_type_idx ON notifications(type)`;
  await sql`CREATE INDEX IF NOT EXISTS notif_status_idx ON notifications(status)`;
  await sql`CREATE INDEX IF NOT EXISTS notif_date_idx ON notifications(created_at)`;

  // ── Bill Payments ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS billers (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      logo_url TEXT,
      customer_id_label TEXT NOT NULL,
      customer_id_pattern TEXT,
      fixed_amounts TEXT,
      min_amount BIGINT,
      max_amount BIGINT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS biller_category_idx ON billers(category)`;
  await sql`CREATE INDEX IF NOT EXISTS biller_country_idx ON billers(country)`;

  await sql`
    CREATE TABLE IF NOT EXISTS saved_billers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      alias TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id, biller_id, customer_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS saved_biller_user_idx ON saved_billers(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_ref TEXT,
      token TEXT,
      receipt_id TEXT REFERENCES receipts(id),
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS bill_payment_user_idx ON bill_payments(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS bill_payment_biller_idx ON bill_payments(biller_id)`;
  await sql`CREATE INDEX IF NOT EXISTS bill_payment_status_idx ON bill_payments(status)`;
  await sql`CREATE INDEX IF NOT EXISTS bill_payment_date_idx ON bill_payments(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      frequency TEXT NOT NULL,
      next_run_at TIMESTAMPTZ NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS scheduled_payment_user_idx ON scheduled_payments(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS scheduled_payment_next_run_idx ON scheduled_payments(next_run_at)`;

  // ── Transfers & Savings ───────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS beneficiaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      bank_code TEXT,
      bank_name TEXT,
      account_name TEXT NOT NULL,
      alias TEXT,
      transfer_count INTEGER NOT NULL DEFAULT 0,
      last_transfer_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id, type, account_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS beneficiary_user_idx ON beneficiaries(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id),
      recipient_type TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      bank_code TEXT,
      bank_name TEXT,
      account_name TEXT,
      amount BIGINT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_ref TEXT NOT NULL,
      receipt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS transfer_sender_idx ON transfers(sender_id)`;
  await sql`CREATE INDEX IF NOT EXISTS transfer_recipient_idx ON transfers(recipient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS transfer_status_idx ON transfers(status)`;
  await sql`CREATE INDEX IF NOT EXISTS transfer_date_idx ON transfers(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS savings_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      target_amount BIGINT NOT NULL,
      current_amount BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      deadline TIMESTAMPTZ,
      locked BOOLEAN NOT NULL DEFAULT false,
      auto_deduct_frequency TEXT NOT NULL DEFAULT 'none',
      auto_deduct_amount BIGINT,
      next_deduct_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS savings_goal_user_idx ON savings_goals(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS savings_goal_status_idx ON savings_goals(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS savings_transactions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES savings_goals(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      transaction_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS savings_txn_goal_idx ON savings_transactions(goal_id)`;
  await sql`CREATE INDEX IF NOT EXISTS savings_txn_user_idx ON savings_transactions(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ajo_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creator_id TEXT NOT NULL REFERENCES users(id),
      contribution_amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      frequency TEXT NOT NULL,
      max_members INTEGER NOT NULL,
      current_round INTEGER NOT NULL DEFAULT 0,
      total_rounds INTEGER NOT NULL,
      next_payout_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'forming',
      invite_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ajo_group_creator_idx ON ajo_groups(creator_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ajo_group_status_idx ON ajo_groups(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ajo_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES ajo_groups(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      total_contributed BIGINT NOT NULL DEFAULT 0,
      total_received BIGINT NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL,
      UNIQUE(group_id, user_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ajo_member_group_idx ON ajo_members(group_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ajo_member_user_idx ON ajo_members(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ajo_contributions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES ajo_groups(id),
      member_id TEXT NOT NULL REFERENCES ajo_members(id),
      round INTEGER NOT NULL,
      amount BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_ref TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ajo_contrib_group_round_idx ON ajo_contributions(group_id, round)`;
  await sql`CREATE INDEX IF NOT EXISTS ajo_contrib_member_idx ON ajo_contributions(member_id)`;

  // ── Health Access ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS health_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      specialty TEXT,
      bio TEXT,
      photo_url TEXT,
      qualifications TEXT,
      license_number TEXT,
      consultation_fee BIGINT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      country TEXT NOT NULL DEFAULT 'NG',
      city TEXT,
      address TEXT,
      latitude TEXT,
      longitude TEXT,
      phone TEXT,
      rating INTEGER DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      languages_spoken TEXT,
      gender TEXT,
      available_now BOOLEAN DEFAULT false,
      operating_hours TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS health_provider_type_idx ON health_providers(type)`;
  await sql`CREATE INDEX IF NOT EXISTS health_provider_specialty_idx ON health_providers(specialty)`;
  await sql`CREATE INDEX IF NOT EXISTS health_provider_country_idx ON health_providers(country)`;
  await sql`CREATE INDEX IF NOT EXISTS health_provider_city_idx ON health_providers(city)`;

  await sql`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      type TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      duration INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'pending',
      consultation_fee BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      notes TEXT,
      cancellation_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS appointment_patient_idx ON appointments(patient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS appointment_provider_idx ON appointments(provider_id)`;
  await sql`CREATE INDEX IF NOT EXISTS appointment_status_idx ON appointments(status)`;
  await sql`CREATE INDEX IF NOT EXISTS appointment_schedule_idx ON appointments(scheduled_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL REFERENCES appointments(id),
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      summary TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS consultation_appt_idx ON consultations(appointment_id)`;
  await sql`CREATE INDEX IF NOT EXISTS consultation_patient_idx ON consultations(patient_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS consultation_messages (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id),
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS msg_consultation_idx ON consultation_messages(consultation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS msg_sender_idx ON consultation_messages(sender_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id),
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      diagnosis TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      receipt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS prescription_consultation_idx ON prescriptions(consultation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS prescription_patient_idx ON prescriptions(patient_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS prescription_items (
      id TEXT PRIMARY KEY,
      prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
      medicine_name TEXT NOT NULL,
      dosage TEXT NOT NULL,
      frequency TEXT NOT NULL,
      duration TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      notes TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS rx_item_prescription_idx ON prescription_items(prescription_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS pharmacy_orders (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      pharmacy_id TEXT NOT NULL REFERENCES health_providers(id),
      prescription_id TEXT REFERENCES prescriptions(id),
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_method TEXT NOT NULL,
      delivery_address TEXT,
      subtotal BIGINT NOT NULL,
      delivery_fee BIGINT NOT NULL DEFAULT 0,
      total BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      receipt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS pharmacy_order_patient_idx ON pharmacy_orders(patient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS pharmacy_order_pharmacy_idx ON pharmacy_orders(pharmacy_id)`;
  await sql`CREATE INDEX IF NOT EXISTS pharmacy_order_status_idx ON pharmacy_orders(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS pharmacy_order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES pharmacy_orders(id),
      medicine_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price BIGINT NOT NULL,
      total BIGINT NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS pharmacy_item_order_idx ON pharmacy_order_items(order_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS insurance_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      coverage_level TEXT NOT NULL,
      premium_amount BIGINT NOT NULL,
      premium_frequency TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      benefits TEXT NOT NULL,
      max_coverage BIGINT,
      waiting_period_days INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS insurance_plan_country_idx ON insurance_plans(country)`;
  await sql`CREATE INDEX IF NOT EXISTS insurance_plan_type_idx ON insurance_plans(type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS user_insurance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      plan_id TEXT NOT NULL REFERENCES insurance_plans(id),
      enrollment_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TIMESTAMPTZ NOT NULL,
      next_premium_date TIMESTAMPTZ,
      total_paid BIGINT NOT NULL DEFAULT 0,
      total_claimed BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS user_insurance_user_idx ON user_insurance(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS user_insurance_plan_idx ON user_insurance(plan_id)`;
  await sql`CREATE INDEX IF NOT EXISTS user_insurance_status_idx ON user_insurance(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS insurance_claims (
      id TEXT PRIMARY KEY,
      enrollment_id TEXT NOT NULL REFERENCES user_insurance(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'submitted',
      evidence_urls TEXT,
      review_notes TEXT,
      approved_amount BIGINT,
      appointment_id TEXT,
      submitted_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS claim_enrollment_idx ON insurance_claims(enrollment_id)`;
  await sql`CREATE INDEX IF NOT EXISTS claim_user_idx ON insurance_claims(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS claim_status_idx ON insurance_claims(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS lab_tests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      price BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      turnaround_hours INTEGER NOT NULL,
      requires_fasting BOOLEAN DEFAULT false,
      sample_type TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS lab_test_category_idx ON lab_tests(category)`;

  await sql`
    CREATE TABLE IF NOT EXISTS lab_bookings (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      lab_id TEXT NOT NULL REFERENCES health_providers(id),
      test_id TEXT NOT NULL REFERENCES lab_tests(id),
      appointment_id TEXT REFERENCES appointments(id),
      prescription_id TEXT REFERENCES prescriptions(id),
      status TEXT NOT NULL DEFAULT 'booked',
      scheduled_at TIMESTAMPTZ NOT NULL,
      result_summary TEXT,
      result_url TEXT,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      receipt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS lab_booking_patient_idx ON lab_bookings(patient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS lab_booking_lab_idx ON lab_bookings(lab_id)`;
  await sql`CREATE INDEX IF NOT EXISTS lab_booking_test_idx ON lab_bookings(test_id)`;
  await sql`CREATE INDEX IF NOT EXISTS lab_booking_status_idx ON lab_bookings(status)`;

  // ── Energy Top-Up ─────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS energy_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      logo TEXT,
      service_charge BIGINT NOT NULL DEFAULT 0,
      vat_rate INTEGER NOT NULL DEFAULT 750,
      meter_types TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS energy_provider_type_idx ON energy_providers(type)`;
  await sql`CREATE INDEX IF NOT EXISTS energy_provider_country_idx ON energy_providers(country)`;

  await sql`
    CREATE TABLE IF NOT EXISTS saved_meters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      type TEXT NOT NULL,
      meter_number TEXT NOT NULL,
      meter_type TEXT,
      customer_name TEXT,
      address TEXT,
      alias TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS saved_meter_user_idx ON saved_meters(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS saved_meter_provider_idx ON saved_meters(provider_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS energy_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      type TEXT NOT NULL,
      meter_number TEXT,
      meter_type TEXT,
      customer_name TEXT,
      amount BIGINT NOT NULL,
      service_charge BIGINT NOT NULL DEFAULT 0,
      vat BIGINT NOT NULL DEFAULT 0,
      total BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      token TEXT,
      units TEXT,
      tariff_class TEXT,
      device_serial TEXT,
      days_unlocked INTEGER,
      cylinder_size TEXT,
      vendor_id TEXT,
      delivery_method TEXT,
      delivery_address TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_ref TEXT,
      receipt_id TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS energy_purchase_user_idx ON energy_purchases(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS energy_purchase_provider_idx ON energy_purchases(provider_id)`;
  await sql`CREATE INDEX IF NOT EXISTS energy_purchase_type_idx ON energy_purchases(type)`;
  await sql`CREATE INDEX IF NOT EXISTS energy_purchase_status_idx ON energy_purchases(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS gas_vendors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      latitude TEXT,
      longitude TEXT,
      phone TEXT,
      rating INTEGER DEFAULT 0,
      price_3kg BIGINT,
      price_6kg BIGINT,
      price_12_5kg BIGINT,
      price_25kg BIGINT,
      price_50kg BIGINT,
      delivery_fee BIGINT DEFAULT 0,
      offers_delivery BOOLEAN DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS gas_vendor_city_idx ON gas_vendors(city)`;
  await sql`CREATE INDEX IF NOT EXISTS gas_vendor_country_idx ON gas_vendors(country)`;

  await sql`
    CREATE TABLE IF NOT EXISTS solar_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      device_serial TEXT NOT NULL,
      device_model TEXT,
      total_cost BIGINT NOT NULL,
      total_paid BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      active_until TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS solar_device_user_idx ON solar_devices(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS solar_device_serial_idx ON solar_devices(device_serial)`;

  // ── Transport Ticketing ───────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS transport_operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      city TEXT NOT NULL,
      logo TEXT,
      website TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS transport_op_type_idx ON transport_operators(type)`;
  await sql`CREATE INDEX IF NOT EXISTS transport_op_city_idx ON transport_operators(city)`;

  await sql`
    CREATE TABLE IF NOT EXISTS transport_routes (
      id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL REFERENCES transport_operators(id),
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      stops TEXT,
      distance_km INTEGER,
      duration_mins INTEGER NOT NULL,
      prices TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS transport_route_operator_idx ON transport_routes(operator_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS transport_schedules (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES transport_routes(id),
      departure_time TIMESTAMPTZ NOT NULL,
      arrival_time TIMESTAMPTZ NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 50,
      available_seats INTEGER NOT NULL DEFAULT 50,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      delay_mins INTEGER NOT NULL DEFAULT 0
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS schedule_route_idx ON transport_schedules(route_id)`;
  await sql`CREATE INDEX IF NOT EXISTS schedule_departure_idx ON transport_schedules(departure_time)`;
  await sql`CREATE INDEX IF NOT EXISTS schedule_status_idx ON transport_schedules(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS transport_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      operator_id TEXT NOT NULL REFERENCES transport_operators(id),
      route_id TEXT NOT NULL REFERENCES transport_routes(id),
      schedule_id TEXT REFERENCES transport_schedules(id),
      ticket_type TEXT NOT NULL,
      adult_count INTEGER NOT NULL DEFAULT 1,
      child_count INTEGER NOT NULL DEFAULT 0,
      unit_price BIGINT NOT NULL,
      total BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      qr_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      transaction_ref TEXT NOT NULL,
      receipt_id TEXT,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ticket_user_idx ON transport_tickets(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ticket_operator_idx ON transport_tickets(operator_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ticket_route_idx ON transport_tickets(route_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ticket_status_idx ON transport_tickets(status)`;
  await sql`CREATE INDEX IF NOT EXISTS ticket_valid_until_idx ON transport_tickets(valid_until)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ridehail_partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      app_deep_link TEXT,
      web_url TEXT,
      logo_url TEXT,
      supports_in_app_payment BOOLEAN DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS ridehail_partner_country_idx ON ridehail_partners(country)`;

  // ── B2B ───────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS b2b_wallets (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance BIGINT NOT NULL DEFAULT 0,
      available_balance BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(developer_id, currency)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS b2b_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES b2b_wallets(id),
      developer_id TEXT NOT NULL REFERENCES developers(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      description TEXT,
      reference TEXT NOT NULL UNIQUE,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS b2b_txn_wallet_idx ON b2b_transactions(wallet_id)`;
  await sql`CREATE INDEX IF NOT EXISTS b2b_txn_dev_idx ON b2b_transactions(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS b2b_txn_status_idx ON b2b_transactions(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS b2b_kyb_records (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      business_name TEXT NOT NULL,
      registration_number TEXT,
      tax_id TEXT,
      country TEXT NOT NULL DEFAULT 'NG',
      business_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      tier INTEGER NOT NULL DEFAULT 1,
      rejection_reason TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS b2b_kyb_dev_idx ON b2b_kyb_records(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS b2b_kyb_status_idx ON b2b_kyb_records(status)`;

  // ── Fleet & Fuel ──────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS fleet_vehicles (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      plate_number TEXT NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      fuel_type TEXT NOT NULL DEFAULT 'petrol',
      status TEXT NOT NULL DEFAULT 'active',
      assigned_driver_name TEXT,
      assigned_driver_phone TEXT,
      odometer INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(developer_id, plate_number)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS fleet_vehicle_dev_idx ON fleet_vehicles(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fleet_vehicle_status_idx ON fleet_vehicles(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS fuel_cards (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      vehicle_id TEXT REFERENCES fleet_vehicles(id),
      card_number TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'Apex Fuel',
      balance BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'active',
      spend_limit BIGINT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS fuel_card_dev_idx ON fuel_cards(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fuel_card_vehicle_idx ON fuel_cards(vehicle_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS fleet_transactions (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      vehicle_id TEXT REFERENCES fleet_vehicles(id),
      fuel_card_id TEXT REFERENCES fuel_cards(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      litres INTEGER,
      price_per_litre BIGINT,
      station TEXT,
      location TEXT,
      odometer INTEGER,
      status TEXT NOT NULL DEFAULT 'completed',
      reference TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS fleet_txn_dev_idx ON fleet_transactions(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fleet_txn_vehicle_idx ON fleet_transactions(vehicle_id)`;
  await sql`CREATE INDEX IF NOT EXISTS fleet_txn_type_idx ON fleet_transactions(type)`;
  await sql`CREATE INDEX IF NOT EXISTS fleet_txn_date_idx ON fleet_transactions(created_at)`;

  // ── Staff Health Plans ────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS staff_health_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier TEXT NOT NULL DEFAULT 'basic',
      monthly_premium BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      coverage_limit BIGINT NOT NULL,
      inpatient_cover BOOLEAN NOT NULL DEFAULT true,
      outpatient_cover BOOLEAN NOT NULL DEFAULT true,
      dental_cover BOOLEAN NOT NULL DEFAULT false,
      optical_cover BOOLEAN NOT NULL DEFAULT false,
      maternity_benefit BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS staff_enrollments (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      plan_id TEXT NOT NULL REFERENCES staff_health_plans(id),
      employee_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      employee_email TEXT,
      employee_phone TEXT,
      date_of_birth TEXT,
      gender TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      effective_date TIMESTAMPTZ NOT NULL,
      expiry_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(developer_id, employee_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS staff_enroll_dev_idx ON staff_enrollments(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS staff_enroll_plan_idx ON staff_enrollments(plan_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS staff_claims (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      enrollment_id TEXT NOT NULL REFERENCES staff_enrollments(id),
      claim_type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      approved_amount BIGINT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      provider_name TEXT,
      diagnosis_code TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS staff_claim_dev_idx ON staff_claims(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS staff_claim_enroll_idx ON staff_claims(enrollment_id)`;
  await sql`CREATE INDEX IF NOT EXISTS staff_claim_status_idx ON staff_claims(status)`;

  // ── Cross-border ──────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS crossborder_recipients (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      alias TEXT NOT NULL,
      full_name TEXT NOT NULL,
      country TEXT NOT NULL,
      currency TEXT NOT NULL,
      bank_name TEXT,
      bank_code TEXT,
      account_number TEXT NOT NULL,
      routing_number TEXT,
      swift_code TEXT,
      iban_number TEXT,
      mobile_wallet_provider TEXT,
      mobile_wallet_number TEXT,
      type TEXT NOT NULL DEFAULT 'bank_account',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS xborder_recipient_dev_idx ON crossborder_recipients(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS xborder_recipient_country_idx ON crossborder_recipients(country)`;

  await sql`
    CREATE TABLE IF NOT EXISTS crossborder_transfers (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      recipient_id TEXT REFERENCES crossborder_recipients(id),
      reference TEXT NOT NULL UNIQUE,
      send_amount BIGINT NOT NULL,
      send_currency TEXT NOT NULL,
      receive_amount BIGINT NOT NULL,
      receive_currency TEXT NOT NULL,
      exchange_rate TEXT NOT NULL,
      fee BIGINT NOT NULL DEFAULT 0,
      fee_currency TEXT NOT NULL DEFAULT 'NGN',
      recipient_name TEXT NOT NULL,
      recipient_country TEXT NOT NULL,
      recipient_account TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'business_payment',
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      initiated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS xborder_transfer_dev_idx ON crossborder_transfers(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS xborder_transfer_status_idx ON crossborder_transfers(status)`;

  // ── Invoicing ─────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      invoice_number TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      subtotal BIGINT NOT NULL,
      tax_rate INTEGER NOT NULL DEFAULT 0,
      tax_amount BIGINT NOT NULL DEFAULT 0,
      discount_amount BIGINT NOT NULL DEFAULT 0,
      total BIGINT NOT NULL,
      amount_paid BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      payment_link TEXT,
      issued_at TIMESTAMPTZ,
      due_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(developer_id, invoice_number)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS invoice_dev_idx ON invoices(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS invoice_status_idx ON invoices(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price BIGINT NOT NULL,
      amount BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS line_item_invoice_idx ON invoice_line_items(invoice_id)`;

  // ── Embedded Finance ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS embedded_wallets (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      external_customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      customer_phone TEXT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance BIGINT NOT NULL DEFAULT 0,
      ledger_balance BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'basic',
      daily_txn_limit BIGINT NOT NULL DEFAULT 50000000,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(developer_id, external_customer_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS emb_wallet_dev_idx ON embedded_wallets(developer_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS embedded_transactions (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      wallet_id TEXT NOT NULL REFERENCES embedded_wallets(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance_before BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      narration TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS emb_txn_dev_idx ON embedded_transactions(developer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS emb_txn_wallet_idx ON embedded_transactions(wallet_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS embedded_webhooks (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS emb_webhook_dev_idx ON embedded_webhooks(developer_id)`;

  // ── Preview Packages ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS preview_packages (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      developer_id TEXT REFERENCES developers(id),
      package_path TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS preview_expires_idx ON preview_packages(expires_at)`;

  // ── Idempotent column additions (run on every startup, safe on existing DBs) ──
  // Add package_data BYTEA to versions so packages survive Railway redeployments.
  await sql`ALTER TABLE versions ADD COLUMN IF NOT EXISTS package_data BYTEA`;
}
