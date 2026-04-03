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

  // Phase 0.4 — supportedCountries on apps
  const appsColumns = sqlite.pragma('table_info(apps)') as Array<{ name: string }>;
  if (!appsColumns.some((c) => c.name === 'supported_countries')) {
    sqlite.exec(`ALTER TABLE apps ADD COLUMN supported_countries TEXT`);
  }

  // Phase 1.1 — Identity tables
  sqlite.exec(`
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
      is_business_user INTEGER NOT NULL DEFAULT 0,
      suspended INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS user_phone_idx ON users(phone);
    CREATE INDEX IF NOT EXISTS user_country_idx ON users(country);

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
      submitted_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS kyc_user_idx ON kyc_records(user_id);
    CREATE INDEX IF NOT EXISTS kyc_status_idx ON kyc_records(status);

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
      submitted_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS kyb_user_idx ON kyb_records(user_id);
    CREATE INDEX IF NOT EXISTS kyb_status_idx ON kyb_records(status);
  `);

  // Phase 1.2 — Wallet tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance INTEGER NOT NULL DEFAULT 0,
      available_balance INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_user_currency_idx ON wallets(user_id, currency);
    CREATE INDEX IF NOT EXISTS wallet_status_idx ON wallets(status);

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      description TEXT,
      counterparty TEXT,
      reference TEXT NOT NULL UNIQUE,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS txn_wallet_idx ON wallet_transactions(wallet_id);
    CREATE INDEX IF NOT EXISTS txn_type_idx ON wallet_transactions(type);
    CREATE INDEX IF NOT EXISTS txn_status_idx ON wallet_transactions(status);
    CREATE UNIQUE INDEX IF NOT EXISTS txn_ref_idx ON wallet_transactions(reference);
    CREATE INDEX IF NOT EXISTS txn_date_idx ON wallet_transactions(created_at);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES wallet_transactions(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      entry_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ledger_txn_idx ON ledger_entries(transaction_id);
    CREATE INDEX IF NOT EXISTS ledger_wallet_idx ON ledger_entries(wallet_id);
  `);

  // Phase 1.3 — Credit Engine tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      score INTEGER NOT NULL,
      band TEXT NOT NULL,
      max_eligible_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      factors TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS credit_score_user_idx ON credit_scores(user_id);

    CREATE TABLE IF NOT EXISTS loan_offers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      product TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      interest_rate REAL NOT NULL,
      tenor_days INTEGER NOT NULL,
      total_repayment INTEGER NOT NULL,
      monthly_repayment INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS offer_user_idx ON loan_offers(user_id);
    CREATE INDEX IF NOT EXISTS offer_status_idx ON loan_offers(status);

    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      offer_id TEXT NOT NULL REFERENCES loan_offers(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      product TEXT NOT NULL,
      amount INTEGER NOT NULL,
      outstanding_balance INTEGER NOT NULL,
      currency TEXT NOT NULL,
      interest_rate REAL NOT NULL,
      total_repayment INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'approved',
      disbursement_ref TEXT,
      disbursed_at INTEGER,
      due_date INTEGER NOT NULL,
      closed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS loan_user_idx ON loans(user_id);
    CREATE INDEX IF NOT EXISTS loan_status_idx ON loans(status);
    CREATE INDEX IF NOT EXISTS loan_due_date_idx ON loans(due_date);

    CREATE TABLE IF NOT EXISTS loan_repayments (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL REFERENCES loans(id),
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      wallet_transaction_id TEXT REFERENCES wallet_transactions(id),
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS repayment_loan_idx ON loan_repayments(loan_id);
  `);

  // Phase 1.4 — Receipts (cross-vertical transaction history)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      vertical TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      counterparty TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      source_ref TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS receipt_user_idx ON receipts(user_id);
    CREATE INDEX IF NOT EXISTS receipt_vertical_idx ON receipts(vertical);
    CREATE INDEX IF NOT EXISTS receipt_type_idx ON receipts(type);
    CREATE INDEX IF NOT EXISTS receipt_status_idx ON receipts(status);
    CREATE INDEX IF NOT EXISTS receipt_date_idx ON receipts(created_at);
    CREATE INDEX IF NOT EXISTS receipt_source_ref_idx ON receipts(source_ref);
  `);

  // Phase 1.5 — Notifications Service
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS push_token_user_idx ON push_tokens(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS push_token_token_idx ON push_tokens(token);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      push_enabled INTEGER NOT NULL DEFAULT 1,
      in_app_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS notif_pref_user_category_idx ON notification_preferences(user_id, category);

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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS notif_type_idx ON notifications(type);
    CREATE INDEX IF NOT EXISTS notif_status_idx ON notifications(status);
    CREATE INDEX IF NOT EXISTS notif_date_idx ON notifications(created_at);
  `);

  // Phase 2.1 — Bill Payments Vertical
  sqlite.exec(`
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
      min_amount INTEGER,
      max_amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'NGN',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS biller_category_idx ON billers(category);
    CREATE INDEX IF NOT EXISTS biller_country_idx ON billers(country);

    CREATE TABLE IF NOT EXISTS saved_billers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      alias TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS saved_biller_user_idx ON saved_billers(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS saved_biller_unique_idx ON saved_billers(user_id, biller_id, customer_id);

    CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_ref TEXT,
      token TEXT,
      receipt_id TEXT REFERENCES receipts(id),
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS bill_payment_user_idx ON bill_payments(user_id);
    CREATE INDEX IF NOT EXISTS bill_payment_biller_idx ON bill_payments(biller_id);
    CREATE INDEX IF NOT EXISTS bill_payment_status_idx ON bill_payments(status);
    CREATE INDEX IF NOT EXISTS bill_payment_date_idx ON bill_payments(created_at);

    CREATE TABLE IF NOT EXISTS scheduled_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      biller_id TEXT NOT NULL REFERENCES billers(id),
      customer_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      frequency TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS scheduled_payment_user_idx ON scheduled_payments(user_id);
    CREATE INDEX IF NOT EXISTS scheduled_payment_next_run_idx ON scheduled_payments(next_run_at);
  `);

  // Phase 2.2 — Transfers & Savings Vertical
  sqlite.exec(`
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
      last_transfer_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS beneficiary_user_idx ON beneficiaries(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS beneficiary_unique_idx ON beneficiaries(user_id, type, account_id);

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id),
      recipient_type TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      bank_code TEXT,
      bank_name TEXT,
      account_name TEXT,
      amount INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_ref TEXT NOT NULL,
      receipt_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS transfer_sender_idx ON transfers(sender_id);
    CREATE INDEX IF NOT EXISTS transfer_recipient_idx ON transfers(recipient_id);
    CREATE INDEX IF NOT EXISTS transfer_status_idx ON transfers(status);
    CREATE INDEX IF NOT EXISTS transfer_date_idx ON transfers(created_at);

    CREATE TABLE IF NOT EXISTS savings_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      target_amount INTEGER NOT NULL,
      current_amount INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      deadline INTEGER,
      locked INTEGER NOT NULL DEFAULT 0,
      auto_deduct_frequency TEXT NOT NULL DEFAULT 'none',
      auto_deduct_amount INTEGER,
      next_deduct_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS savings_goal_user_idx ON savings_goals(user_id);
    CREATE INDEX IF NOT EXISTS savings_goal_status_idx ON savings_goals(status);

    CREATE TABLE IF NOT EXISTS savings_transactions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES savings_goals(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      transaction_ref TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS savings_txn_goal_idx ON savings_transactions(goal_id);
    CREATE INDEX IF NOT EXISTS savings_txn_user_idx ON savings_transactions(user_id);

    CREATE TABLE IF NOT EXISTS ajo_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creator_id TEXT NOT NULL REFERENCES users(id),
      contribution_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      frequency TEXT NOT NULL,
      max_members INTEGER NOT NULL,
      current_round INTEGER NOT NULL DEFAULT 0,
      total_rounds INTEGER NOT NULL,
      next_payout_at INTEGER,
      status TEXT NOT NULL DEFAULT 'forming',
      invite_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ajo_group_creator_idx ON ajo_groups(creator_id);
    CREATE INDEX IF NOT EXISTS ajo_group_status_idx ON ajo_groups(status);

    CREATE TABLE IF NOT EXISTS ajo_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES ajo_groups(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      total_contributed INTEGER NOT NULL DEFAULT 0,
      total_received INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ajo_member_group_idx ON ajo_members(group_id);
    CREATE INDEX IF NOT EXISTS ajo_member_user_idx ON ajo_members(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ajo_member_unique_idx ON ajo_members(group_id, user_id);

    CREATE TABLE IF NOT EXISTS ajo_contributions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES ajo_groups(id),
      member_id TEXT NOT NULL REFERENCES ajo_members(id),
      round INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_ref TEXT,
      paid_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ajo_contrib_group_round_idx ON ajo_contributions(group_id, round);
    CREATE INDEX IF NOT EXISTS ajo_contrib_member_idx ON ajo_contributions(member_id);

    -- Phase 2.3: Health Access
    CREATE TABLE IF NOT EXISTS health_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      specialty TEXT,
      bio TEXT,
      photo_url TEXT,
      qualifications TEXT,
      license_number TEXT,
      consultation_fee INTEGER,
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
      available_now INTEGER DEFAULT 0,
      operating_hours TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS health_provider_type_idx ON health_providers(type);
    CREATE INDEX IF NOT EXISTS health_provider_specialty_idx ON health_providers(specialty);
    CREATE INDEX IF NOT EXISTS health_provider_country_idx ON health_providers(country);
    CREATE INDEX IF NOT EXISTS health_provider_city_idx ON health_providers(city);

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      type TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      duration INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'pending',
      consultation_fee INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      notes TEXT,
      cancellation_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS appointment_patient_idx ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS appointment_provider_idx ON appointments(provider_id);
    CREATE INDEX IF NOT EXISTS appointment_status_idx ON appointments(status);
    CREATE INDEX IF NOT EXISTS appointment_schedule_idx ON appointments(scheduled_at);

    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL REFERENCES appointments(id),
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      status TEXT NOT NULL DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS consultation_appt_idx ON consultations(appointment_id);
    CREATE INDEX IF NOT EXISTS consultation_patient_idx ON consultations(patient_id);

    CREATE TABLE IF NOT EXISTS consultation_messages (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id),
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS msg_consultation_idx ON consultation_messages(consultation_id);
    CREATE INDEX IF NOT EXISTS msg_sender_idx ON consultation_messages(sender_id);

    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id),
      patient_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES health_providers(id),
      diagnosis TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      receipt_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS prescription_consultation_idx ON prescriptions(consultation_id);
    CREATE INDEX IF NOT EXISTS prescription_patient_idx ON prescriptions(patient_id);

    CREATE TABLE IF NOT EXISTS prescription_items (
      id TEXT PRIMARY KEY,
      prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
      medicine_name TEXT NOT NULL,
      dosage TEXT NOT NULL,
      frequency TEXT NOT NULL,
      duration TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS rx_item_prescription_idx ON prescription_items(prescription_id);

    CREATE TABLE IF NOT EXISTS pharmacy_orders (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      pharmacy_id TEXT NOT NULL REFERENCES health_providers(id),
      prescription_id TEXT REFERENCES prescriptions(id),
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_method TEXT NOT NULL,
      delivery_address TEXT,
      subtotal INTEGER NOT NULL,
      delivery_fee INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      receipt_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pharmacy_order_patient_idx ON pharmacy_orders(patient_id);
    CREATE INDEX IF NOT EXISTS pharmacy_order_pharmacy_idx ON pharmacy_orders(pharmacy_id);
    CREATE INDEX IF NOT EXISTS pharmacy_order_status_idx ON pharmacy_orders(status);

    CREATE TABLE IF NOT EXISTS pharmacy_order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES pharmacy_orders(id),
      medicine_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      total INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pharmacy_item_order_idx ON pharmacy_order_items(order_id);

    CREATE TABLE IF NOT EXISTS insurance_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      coverage_level TEXT NOT NULL,
      premium_amount INTEGER NOT NULL,
      premium_frequency TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      benefits TEXT NOT NULL,
      max_coverage INTEGER,
      waiting_period_days INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS insurance_plan_country_idx ON insurance_plans(country);
    CREATE INDEX IF NOT EXISTS insurance_plan_type_idx ON insurance_plans(type);

    CREATE TABLE IF NOT EXISTS user_insurance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      plan_id TEXT NOT NULL REFERENCES insurance_plans(id),
      enrollment_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      start_date INTEGER NOT NULL,
      next_premium_date INTEGER,
      total_paid INTEGER NOT NULL DEFAULT 0,
      total_claimed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS user_insurance_user_idx ON user_insurance(user_id);
    CREATE INDEX IF NOT EXISTS user_insurance_plan_idx ON user_insurance(plan_id);
    CREATE INDEX IF NOT EXISTS user_insurance_status_idx ON user_insurance(status);

    CREATE TABLE IF NOT EXISTS insurance_claims (
      id TEXT PRIMARY KEY,
      enrollment_id TEXT NOT NULL REFERENCES user_insurance(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'submitted',
      evidence_urls TEXT,
      review_notes TEXT,
      approved_amount INTEGER,
      appointment_id TEXT,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS claim_enrollment_idx ON insurance_claims(enrollment_id);
    CREATE INDEX IF NOT EXISTS claim_user_idx ON insurance_claims(user_id);
    CREATE INDEX IF NOT EXISTS claim_status_idx ON insurance_claims(status);

    CREATE TABLE IF NOT EXISTS lab_tests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      turnaround_hours INTEGER NOT NULL,
      requires_fasting INTEGER DEFAULT 0,
      sample_type TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS lab_test_category_idx ON lab_tests(category);

    CREATE TABLE IF NOT EXISTS lab_bookings (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      lab_id TEXT NOT NULL REFERENCES health_providers(id),
      test_id TEXT NOT NULL REFERENCES lab_tests(id),
      appointment_id TEXT REFERENCES appointments(id),
      prescription_id TEXT REFERENCES prescriptions(id),
      status TEXT NOT NULL DEFAULT 'booked',
      scheduled_at INTEGER NOT NULL,
      result_summary TEXT,
      result_url TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      transaction_ref TEXT,
      receipt_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS lab_booking_patient_idx ON lab_bookings(patient_id);
    CREATE INDEX IF NOT EXISTS lab_booking_lab_idx ON lab_bookings(lab_id);
    CREATE INDEX IF NOT EXISTS lab_booking_test_idx ON lab_bookings(test_id);
    CREATE INDEX IF NOT EXISTS lab_booking_status_idx ON lab_bookings(status);
  `);

  // =========================================================================
  // Phase 2.4 — Energy Top-Up
  // =========================================================================
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS energy_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('electricity','solar','gas')),
      country TEXT NOT NULL DEFAULT 'NG',
      logo TEXT,
      service_charge INTEGER NOT NULL DEFAULT 0,
      vat_rate INTEGER NOT NULL DEFAULT 750,
      meter_types TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS energy_provider_type_idx ON energy_providers(type);
    CREATE INDEX IF NOT EXISTS energy_provider_country_idx ON energy_providers(country);

    CREATE TABLE IF NOT EXISTS saved_meters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      type TEXT NOT NULL CHECK(type IN ('electricity','solar','gas')),
      meter_number TEXT NOT NULL,
      meter_type TEXT,
      customer_name TEXT,
      address TEXT,
      alias TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS saved_meter_user_idx ON saved_meters(user_id);
    CREATE INDEX IF NOT EXISTS saved_meter_provider_idx ON saved_meters(provider_id);

    CREATE TABLE IF NOT EXISTS energy_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      type TEXT NOT NULL CHECK(type IN ('electricity','solar','gas')),
      meter_number TEXT,
      meter_type TEXT,
      customer_name TEXT,
      amount INTEGER NOT NULL,
      service_charge INTEGER NOT NULL DEFAULT 0,
      vat INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
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
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','refunded')),
      transaction_ref TEXT,
      receipt_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS energy_purchase_user_idx ON energy_purchases(user_id);
    CREATE INDEX IF NOT EXISTS energy_purchase_provider_idx ON energy_purchases(provider_id);
    CREATE INDEX IF NOT EXISTS energy_purchase_type_idx ON energy_purchases(type);
    CREATE INDEX IF NOT EXISTS energy_purchase_status_idx ON energy_purchases(status);

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
      price_3kg INTEGER,
      price_6kg INTEGER,
      price_12_5kg INTEGER,
      price_25kg INTEGER,
      price_50kg INTEGER,
      delivery_fee INTEGER DEFAULT 0,
      offers_delivery INTEGER DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS gas_vendor_city_idx ON gas_vendors(city);
    CREATE INDEX IF NOT EXISTS gas_vendor_country_idx ON gas_vendors(country);

    CREATE TABLE IF NOT EXISTS solar_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL REFERENCES energy_providers(id),
      device_serial TEXT NOT NULL,
      device_model TEXT,
      total_cost INTEGER NOT NULL,
      total_paid INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      active_until INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','locked','owned')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS solar_device_user_idx ON solar_devices(user_id);
    CREATE INDEX IF NOT EXISTS solar_device_serial_idx ON solar_devices(device_serial);
  `);

  // Phase 2.5 — Transport Ticketing
  // =========================================================================
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS transport_operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('brt','bus','ferry','rail','ridehail')),
      country TEXT NOT NULL DEFAULT 'NG',
      city TEXT NOT NULL,
      logo TEXT,
      website TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS transport_op_type_idx ON transport_operators(type);
    CREATE INDEX IF NOT EXISTS transport_op_city_idx ON transport_operators(city);

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
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS transport_route_operator_idx ON transport_routes(operator_id);

    CREATE TABLE IF NOT EXISTS transport_schedules (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES transport_routes(id),
      departure_time INTEGER NOT NULL,
      arrival_time INTEGER NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 50,
      available_seats INTEGER NOT NULL DEFAULT 50,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','delayed','cancelled','departed')),
      delay_mins INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS schedule_route_idx ON transport_schedules(route_id);
    CREATE INDEX IF NOT EXISTS schedule_departure_idx ON transport_schedules(departure_time);
    CREATE INDEX IF NOT EXISTS schedule_status_idx ON transport_schedules(status);

    CREATE TABLE IF NOT EXISTS transport_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      operator_id TEXT NOT NULL REFERENCES transport_operators(id),
      route_id TEXT NOT NULL REFERENCES transport_routes(id),
      schedule_id TEXT REFERENCES transport_schedules(id),
      ticket_type TEXT NOT NULL CHECK(ticket_type IN ('single','return','day_pass','weekly_pass')),
      adult_count INTEGER NOT NULL DEFAULT 1,
      child_count INTEGER NOT NULL DEFAULT 0,
      unit_price INTEGER NOT NULL,
      total INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      qr_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','used','expired','refunded')),
      valid_from INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      used_at INTEGER,
      transaction_ref TEXT NOT NULL,
      receipt_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_user_idx ON transport_tickets(user_id);
    CREATE INDEX IF NOT EXISTS ticket_operator_idx ON transport_tickets(operator_id);
    CREATE INDEX IF NOT EXISTS ticket_route_idx ON transport_tickets(route_id);
    CREATE INDEX IF NOT EXISTS ticket_status_idx ON transport_tickets(status);
    CREATE INDEX IF NOT EXISTS ticket_valid_until_idx ON transport_tickets(valid_until);

    CREATE TABLE IF NOT EXISTS ridehail_partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'NG',
      app_deep_link TEXT,
      web_url TEXT,
      logo_url TEXT,
      supports_in_app_payment INTEGER DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS ridehail_partner_country_idx ON ridehail_partners(country);

    -- B2B wallets and KYB
    CREATE TABLE IF NOT EXISTS b2b_wallets (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance INTEGER NOT NULL DEFAULT 0,
      available_balance INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS b2b_wallet_dev_currency_idx ON b2b_wallets(developer_id, currency);

    CREATE TABLE IF NOT EXISTS b2b_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES b2b_wallets(id),
      developer_id TEXT NOT NULL REFERENCES developers(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      description TEXT,
      reference TEXT NOT NULL UNIQUE,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS b2b_txn_wallet_idx ON b2b_transactions(wallet_id);
    CREATE INDEX IF NOT EXISTS b2b_txn_dev_idx ON b2b_transactions(developer_id);
    CREATE INDEX IF NOT EXISTS b2b_txn_status_idx ON b2b_transactions(status);
    CREATE UNIQUE INDEX IF NOT EXISTS b2b_txn_ref_idx ON b2b_transactions(reference);

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
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS b2b_kyb_dev_idx ON b2b_kyb_records(developer_id);
    CREATE INDEX IF NOT EXISTS b2b_kyb_status_idx ON b2b_kyb_records(status);

    -- Fleet & Fuel Management
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fleet_vehicle_dev_idx ON fleet_vehicles(developer_id);
    CREATE INDEX IF NOT EXISTS fleet_vehicle_status_idx ON fleet_vehicles(status);
    CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicle_plate_idx ON fleet_vehicles(developer_id, plate_number);

    CREATE TABLE IF NOT EXISTS fuel_cards (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      vehicle_id TEXT REFERENCES fleet_vehicles(id),
      card_number TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'Apex Fuel',
      balance INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'active',
      spend_limit INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fuel_card_dev_idx ON fuel_cards(developer_id);
    CREATE INDEX IF NOT EXISTS fuel_card_vehicle_idx ON fuel_cards(vehicle_id);

    CREATE TABLE IF NOT EXISTS fleet_transactions (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      vehicle_id TEXT REFERENCES fleet_vehicles(id),
      fuel_card_id TEXT REFERENCES fuel_cards(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      litres INTEGER,
      price_per_litre INTEGER,
      station TEXT,
      location TEXT,
      odometer INTEGER,
      status TEXT NOT NULL DEFAULT 'completed',
      reference TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fleet_txn_dev_idx ON fleet_transactions(developer_id);
    CREATE INDEX IF NOT EXISTS fleet_txn_vehicle_idx ON fleet_transactions(vehicle_id);
    CREATE INDEX IF NOT EXISTS fleet_txn_type_idx ON fleet_transactions(type);
    CREATE INDEX IF NOT EXISTS fleet_txn_date_idx ON fleet_transactions(created_at);

    -- Staff Health Plans
    CREATE TABLE IF NOT EXISTS staff_health_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier TEXT NOT NULL DEFAULT 'basic',
      monthly_premium INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      coverage_limit INTEGER NOT NULL,
      inpatient_cover INTEGER NOT NULL DEFAULT 1,
      outpatient_cover INTEGER NOT NULL DEFAULT 1,
      dental_cover INTEGER NOT NULL DEFAULT 0,
      optical_cover INTEGER NOT NULL DEFAULT 0,
      maternity_benefit INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

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
      effective_date INTEGER NOT NULL,
      expiry_date INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS staff_enroll_dev_idx ON staff_enrollments(developer_id);
    CREATE INDEX IF NOT EXISTS staff_enroll_plan_idx ON staff_enrollments(plan_id);
    CREATE UNIQUE INDEX IF NOT EXISTS staff_enroll_emp_idx ON staff_enrollments(developer_id, employee_id);

    CREATE TABLE IF NOT EXISTS staff_claims (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      enrollment_id TEXT NOT NULL REFERENCES staff_enrollments(id),
      claim_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      approved_amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'NGN',
      provider_name TEXT,
      diagnosis_code TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      paid_at INTEGER,
      rejection_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS staff_claim_dev_idx ON staff_claims(developer_id);
    CREATE INDEX IF NOT EXISTS staff_claim_enroll_idx ON staff_claims(enrollment_id);
    CREATE INDEX IF NOT EXISTS staff_claim_status_idx ON staff_claims(status);

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
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xborder_recipient_dev_idx ON crossborder_recipients(developer_id);
    CREATE INDEX IF NOT EXISTS xborder_recipient_country_idx ON crossborder_recipients(country);

    CREATE TABLE IF NOT EXISTS crossborder_transfers (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      recipient_id TEXT REFERENCES crossborder_recipients(id),
      reference TEXT NOT NULL UNIQUE,
      send_amount INTEGER NOT NULL,
      send_currency TEXT NOT NULL,
      receive_amount INTEGER NOT NULL,
      receive_currency TEXT NOT NULL,
      exchange_rate TEXT NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      fee_currency TEXT NOT NULL DEFAULT 'NGN',
      recipient_name TEXT NOT NULL,
      recipient_country TEXT NOT NULL,
      recipient_account TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'business_payment',
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      initiated_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xborder_transfer_dev_idx ON crossborder_transfers(developer_id);
    CREATE INDEX IF NOT EXISTS xborder_transfer_status_idx ON crossborder_transfers(status);
    CREATE UNIQUE INDEX IF NOT EXISTS xborder_transfer_ref_idx ON crossborder_transfers(reference);

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      invoice_number TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      subtotal INTEGER NOT NULL,
      tax_rate INTEGER NOT NULL DEFAULT 0,
      tax_amount INTEGER NOT NULL DEFAULT 0,
      discount_amount INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      amount_paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      payment_link TEXT,
      issued_at INTEGER,
      due_at INTEGER,
      paid_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invoice_dev_idx ON invoices(developer_id);
    CREATE INDEX IF NOT EXISTS invoice_status_idx ON invoices(status);
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_num_idx ON invoices(developer_id, invoice_number);

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS line_item_invoice_idx ON invoice_line_items(invoice_id);

    CREATE TABLE IF NOT EXISTS embedded_wallets (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      external_customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      customer_phone TEXT,
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance INTEGER NOT NULL DEFAULT 0,
      ledger_balance INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'basic',
      daily_txn_limit INTEGER NOT NULL DEFAULT 50000000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS emb_wallet_dev_idx ON embedded_wallets(developer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS emb_wallet_ext_cust_idx ON embedded_wallets(developer_id, external_customer_id);

    CREATE TABLE IF NOT EXISTS embedded_transactions (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      wallet_id TEXT NOT NULL REFERENCES embedded_wallets(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      balance_before INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      narration TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS emb_txn_dev_idx ON embedded_transactions(developer_id);
    CREATE INDEX IF NOT EXISTS emb_txn_wallet_idx ON embedded_transactions(wallet_id);
    CREATE UNIQUE INDEX IF NOT EXISTS emb_txn_ref_idx ON embedded_transactions(reference);

    CREATE TABLE IF NOT EXISTS embedded_webhooks (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL REFERENCES developers(id),
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS emb_webhook_dev_idx ON embedded_webhooks(developer_id);
  `);

  // Phase 3.1 — Preview Packages (CLI `apex preview --upload`)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS preview_packages (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      developer_id TEXT REFERENCES developers(id),
      package_path TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS preview_token_idx ON preview_packages(token);
    CREATE INDEX IF NOT EXISTS preview_expires_idx ON preview_packages(expires_at);
  `);
}