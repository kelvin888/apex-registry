/**
 * Database Schema
 *
 * Defines the database tables for the distribution server (PostgreSQL)
 */

import { pgTable, text, integer, doublePrecision, boolean, bigint, timestamp, uniqueIndex, index, customType } from 'drizzle-orm/pg-core';

// Custom bytea type — stores raw binary as a Node.js Buffer
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});

/**
 * Developers - registered developers/organizations
 */
export const developers = pgTable('developers', {
  id: text('id').primaryKey(), // nanoid
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  organization: text('organization'),
  apiKey: text('api_key').notNull().unique(),
  apiKeyHash: text('api_key_hash').notNull(),
  role: text('role', { enum: ['developer', 'admin'] }).notNull().default('developer'),
  suspended: boolean('suspended').notNull().default(false),
  verified: boolean('verified').notNull().default(false),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/**
 * Apps - registered mini-apps
 */
export const apps = pgTable('apps', {
  id: text('id').primaryKey(), // nanoid
  appId: text('app_id').notNull().unique(), // com.example.myapp
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'), // URL to icon
  category: text('category'),
  platform: text('platform', { enum: ['mobile', 'web', 'universal'] }).notNull().default('mobile'),
  status: text('status', { enum: ['draft', 'pending', 'approved', 'rejected', 'suspended'] }).notNull().default('draft'),
  isPublic: boolean('is_public').notNull().default(false),
  supportedCountries: text('supported_countries'), // JSON array of ISO 3166-1 alpha-2 codes
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  appIdIdx: uniqueIndex('app_id_idx').on(table.appId),
  developerIdx: index('developer_idx').on(table.developerId),
  statusIdx: index('status_idx').on(table.status),
}));

/**
 * Versions - app versions/releases
 */
export const versions = pgTable('versions', {
  id: text('id').primaryKey(), // nanoid
  appId: text('app_id').notNull().references(() => apps.id),
  version: text('version').notNull(), // semver: 1.0.0
  versionCode: integer('version_code').notNull(), // incremental: 1, 2, 3...
  changelog: text('changelog'),
  minHostVersion: text('min_host_version'), // minimum host app version
  permissions: text('permissions'), // JSON array of required permissions
  status: text('status', { enum: ['uploading', 'processing', 'ready', 'failed'] }).notNull().default('uploading'),
  packagePath: text('package_path'), // path to .map file (legacy, may be null after DB-storage migration)
  packageData: bytea('package_data'), // .map file bytes stored directly in DB (survives redeployments)
  packageSize: integer('package_size'), // bytes
  packageHash: text('package_hash'), // SHA256
  signature: text('signature'), // package signature
  metadata: text('metadata'), // JSON metadata from app.json
  createdAt: timestamp('created_at').notNull(),
  publishedAt: timestamp('published_at'),
}, (table) => ({
  appVersionIdx: uniqueIndex('app_version_idx').on(table.appId, table.version),
  appVersionCodeIdx: uniqueIndex('app_version_code_idx').on(table.appId, table.versionCode),
}));

/**
 * Downloads - download analytics
 */
export const downloads = pgTable('downloads', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull().references(() => versions.id),
  hostAppId: text('host_app_id'), // which host app downloaded
  hostVersion: text('host_version'),
  platform: text('platform'), // ios, android
  region: text('region'), // country code
  ipHash: text('ip_hash'), // hashed IP for uniqueness
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  versionIdx: index('download_version_idx').on(table.versionId),
  dateIdx: index('download_date_idx').on(table.createdAt),
}));

/**
 * API Keys - additional API keys for CI/CD
 */
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(), // "CI Key", "Production Key"
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(), // first 8 chars for identification
  permissions: text('permissions').notNull(), // JSON array: ["upload", "publish"]
  lastUsedAt: timestamp('last_used_at'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  developerIdx: index('api_key_developer_idx').on(table.developerId),
}));

/**
 * Certificates - signing certificates
 */
export const certificates = pgTable('certificates', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  name: text('name').notNull(),
  publicKey: text('public_key').notNull(),
  fingerprint: text('fingerprint').notNull().unique(),
  algorithm: text('algorithm').notNull().default('RSA-SHA256'),
  isDefault: boolean('is_default').notNull().default(false),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  developerIdx: index('cert_developer_idx').on(table.developerId),
}));

/**
 * Reviews - app review queue
 */
export const reviews = pgTable('reviews', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull().references(() => versions.id),
  reviewerId: text('reviewer_id').references(() => developers.id), // admin who reviewed
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  notes: text('notes'), // reviewer notes
  rejectionReason: text('rejection_reason'),
  submittedAt: timestamp('submitted_at').notNull(),
  reviewedAt: timestamp('reviewed_at'),
}, (table) => ({
  versionIdx: index('review_version_idx').on(table.versionId),
  statusIdx: index('review_status_idx').on(table.status),
}));

// Type exports
export type Developer = typeof developers.$inferSelect;
export type NewDeveloper = typeof developers.$inferInsert;
export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
export type Download = typeof downloads.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
export type Review = typeof reviews.$inferSelect;

// =============================================================================
// IDENTITY SERVICE TABLES
// =============================================================================

/**
 * Users - end-users of the super app (consumers/businesses)
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(), // nanoid
  phone: text('phone').notNull().unique(),
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  avatar: text('avatar'),
  country: text('country').notNull().default('NG'), // ISO 3166-1 alpha-2
  kycLevel: text('kyc_level', { enum: ['none', 'basic', 'full', 'enhanced'] }).notNull().default('none'),
  kybLevel: text('kyb_level', { enum: ['none', 'registered', 'verified', 'trusted'] }).notNull().default('none'),
  isBusinessUser: boolean('is_business_user').notNull().default(false),
  suspended: boolean('suspended').notNull().default(false),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  phoneIdx: uniqueIndex('user_phone_idx').on(table.phone),
  countryIdx: index('user_country_idx').on(table.country),
}));

/**
 * KYC Records - KYC verification submissions and reviews
 */
export const kycRecords = pgTable('kyc_records', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  targetLevel: text('target_level', { enum: ['basic', 'full', 'enhanced'] }).notNull(),
  status: text('status', { enum: ['not_started', 'pending', 'under_review', 'approved', 'rejected'] }).notNull().default('pending'),
  country: text('country').notNull(),
  nationalIdType: text('national_id_type'), // bvn, huduma_namba, ghana_card, etc.
  nationalIdHash: text('national_id_hash'), // hashed for privacy
  documentType: text('document_type'), // national_id, passport, drivers_license
  verifiedFields: text('verified_fields'), // JSON array
  nextStep: text('next_step'),
  rejectionReason: text('rejection_reason'),
  reviewerId: text('reviewer_id').references(() => developers.id),
  submittedAt: timestamp('submitted_at').notNull(),
  reviewedAt: timestamp('reviewed_at'),
}, (table) => ({
  userIdx: index('kyc_user_idx').on(table.userId),
  statusIdx: index('kyc_status_idx').on(table.status),
}));

/**
 * KYB Records - KYB verification submissions and reviews
 */
export const kybRecords = pgTable('kyb_records', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  targetLevel: text('target_level', { enum: ['registered', 'verified', 'trusted'] }).notNull(),
  status: text('status', { enum: ['not_started', 'pending', 'under_review', 'approved', 'rejected'] }).notNull().default('pending'),
  country: text('country').notNull(),
  businessName: text('business_name'),
  businessType: text('business_type', { enum: ['sole_proprietor', 'llc', 'plc', 'ngo', 'cooperative'] }),
  registrationNumber: text('registration_number'),
  registrationDocType: text('registration_doc_type'),
  taxId: text('tax_id'),
  verifiedFields: text('verified_fields'), // JSON array
  nextStep: text('next_step'),
  rejectionReason: text('rejection_reason'),
  reviewerId: text('reviewer_id').references(() => developers.id),
  submittedAt: timestamp('submitted_at').notNull(),
  reviewedAt: timestamp('reviewed_at'),
}, (table) => ({
  userIdx: index('kyb_user_idx').on(table.userId),
  statusIdx: index('kyb_status_idx').on(table.status),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type KycRecord = typeof kycRecords.$inferSelect;
export type NewKycRecord = typeof kycRecords.$inferInsert;
export type KybRecord = typeof kybRecords.$inferSelect;
export type NewKybRecord = typeof kybRecords.$inferInsert;

// =============================================================================
// WALLET SERVICE TABLES
// =============================================================================

/**
 * Wallets — one per user per currency
 */
export const wallets = pgTable('wallets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  currency: text('currency').notNull().default('NGN'),
  /** Balance in minor units (kobo, cents, etc.) */
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  /** Available balance (excludes holds/pending debits) */
  availableBalance: bigint('available_balance', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['active', 'frozen', 'closed'] }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userCurrencyIdx: uniqueIndex('wallet_user_currency_idx').on(table.userId, table.currency),
  statusIdx: index('wallet_status_idx').on(table.status),
}));

/**
 * Wallet Transactions — every operation on a wallet
 */
export const walletTransactions = pgTable('wallet_transactions', {
  id: text('id').primaryKey(),
  walletId: text('wallet_id').notNull().references(() => wallets.id),
  type: text('type', {
    enum: ['fund', 'withdraw', 'transfer', 'payment', 'refund', 'loan_disbursement', 'loan_repayment'],
  }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(), // minor units, always positive
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'failed', 'reversed'] }).notNull().default('pending'),
  description: text('description'),
  counterparty: text('counterparty'),
  reference: text('reference').notNull().unique(),
  metadata: text('metadata'), // JSON
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  walletIdx: index('txn_wallet_idx').on(table.walletId),
  typeIdx: index('txn_type_idx').on(table.type),
  statusIdx: index('txn_status_idx').on(table.status),
  refIdx: uniqueIndex('txn_ref_idx').on(table.reference),
  dateIdx: index('txn_date_idx').on(table.createdAt),
}));

/**
 * Ledger Entries — double-entry bookkeeping.
 * Every transaction produces exactly two entries: one debit, one credit.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => walletTransactions.id),
  walletId: text('wallet_id').notNull().references(() => wallets.id),
  entryType: text('entry_type', { enum: ['debit', 'credit'] }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(), // always positive
  balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  txnIdx: index('ledger_txn_idx').on(table.transactionId),
  walletIdx: index('ledger_wallet_idx').on(table.walletId),
}));

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;

// =============================================================================
// PHASE 1.3 — CREDIT ENGINE
// =============================================================================

/**
 * Credit Scores — cached credit assessment per user
 */
export const creditScores = pgTable('credit_scores', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  score: integer('score').notNull(), // 0-1000
  band: text('band', { enum: ['poor', 'fair', 'good', 'excellent'] }).notNull(),
  maxEligibleAmount: bigint('max_eligible_amount', { mode: 'number' }).notNull(), // minor units
  currency: text('currency').notNull().default('NGN'),
  factors: text('factors').notNull(), // JSON array of ScoreFactor
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userIdx: uniqueIndex('credit_score_user_idx').on(table.userId),
}));

/**
 * Loan Offers — generated offers awaiting acceptance
 */
export const loanOffers = pgTable('loan_offers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  product: text('product', {
    enum: ['nano_loan', 'working_capital', 'invoice_financing', 'merchant_advance'],
  }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  interestRate: doublePrecision('interest_rate').notNull(),
  tenorDays: integer('tenor_days').notNull(),
  totalRepayment: bigint('total_repayment', { mode: 'number' }).notNull(),
  monthlyRepayment: bigint('monthly_repayment', { mode: 'number' }).notNull(),
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  purpose: text('purpose'),
  status: text('status', { enum: ['pending', 'accepted', 'expired', 'rejected'] }).notNull().default('pending'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('offer_user_idx').on(table.userId),
  statusIdx: index('offer_status_idx').on(table.status),
}));

/**
 * Loans — active/completed loans
 */
export const loans = pgTable('loans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  offerId: text('offer_id').notNull().references(() => loanOffers.id),
  walletId: text('wallet_id').notNull().references(() => wallets.id),
  product: text('product', {
    enum: ['nano_loan', 'working_capital', 'invoice_financing', 'merchant_advance'],
  }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  outstandingBalance: bigint('outstanding_balance', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  interestRate: doublePrecision('interest_rate').notNull(),
  totalRepayment: bigint('total_repayment', { mode: 'number' }).notNull(),
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  status: text('status', {
    enum: ['pending', 'approved', 'active', 'repaid', 'overdue', 'defaulted', 'rejected'],
  }).notNull().default('approved'),
  disbursementRef: text('disbursement_ref'),
  disbursedAt: timestamp('disbursed_at'),
  dueDate: timestamp('due_date').notNull(),
  closedAt: timestamp('closed_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('loan_user_idx').on(table.userId),
  statusIdx: index('loan_status_idx').on(table.status),
  dueDateIdx: index('loan_due_date_idx').on(table.dueDate),
}));

/**
 * Loan Repayments — payment records against loans
 */
export const loanRepayments = pgTable('loan_repayments', {
  id: text('id').primaryKey(),
  loanId: text('loan_id').notNull().references(() => loans.id),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  type: text('type', { enum: ['scheduled', 'manual', 'auto_debit'] }).notNull(),
  walletTransactionId: text('wallet_transaction_id').references(() => walletTransactions.id),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  loanIdx: index('repayment_loan_idx').on(table.loanId),
}));

export type CreditScore = typeof creditScores.$inferSelect;
export type LoanOffer = typeof loanOffers.$inferSelect;
export type NewLoanOffer = typeof loanOffers.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type NewLoan = typeof loans.$inferInsert;
export type LoanRepayment = typeof loanRepayments.$inferSelect;

// =============================================================================
// PHASE 1.4 — CROSS-VERTICAL TRANSACTION HISTORY
// =============================================================================

/**
 * Receipts — unified receipt store across all verticals.
 * Every transaction (wallet, credit, etc.) generates a receipt entry.
 */
export const receipts = pgTable('receipts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  vertical: text('vertical').notNull(), // e.g. 'wallet', 'credit', 'bill_payments', 'transport'
  type: text('type').notNull(), // e.g. 'fund', 'transfer', 'loan_disbursement', 'airtime'
  amount: bigint('amount', { mode: 'number' }).notNull(), // minor units
  currency: text('currency').notNull(),
  description: text('description').notNull(),
  counterparty: text('counterparty'),
  status: text('status', { enum: ['completed', 'pending', 'failed', 'refunded'] }).notNull(),
  /** Reference to the originating transaction (e.g. wallet transaction ref) */
  sourceRef: text('source_ref'),
  metadata: text('metadata'), // JSON — vertical-specific data
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('receipt_user_idx').on(table.userId),
  verticalIdx: index('receipt_vertical_idx').on(table.vertical),
  typeIdx: index('receipt_type_idx').on(table.type),
  statusIdx: index('receipt_status_idx').on(table.status),
  dateIdx: index('receipt_date_idx').on(table.createdAt),
  sourceRefIdx: index('receipt_source_ref_idx').on(table.sourceRef),
}));

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;

// =============================================================================
// PHASE 1.5 — NOTIFICATIONS SERVICE
// =============================================================================

/**
 * Push Tokens — device registrations for FCM / APNs.
 */
export const pushTokens = pgTable('push_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  token: text('token').notNull(),
  platform: text('platform', { enum: ['android', 'ios', 'web'] }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userIdx: index('push_token_user_idx').on(table.userId),
  tokenIdx: uniqueIndex('push_token_token_idx').on(table.token),
}));

/**
 * Notification Preferences — per-user, per-category opt-in/out.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  category: text('category', { enum: ['transactional', 'promotional', 'system'] }).notNull(),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  inAppEnabled: boolean('in_app_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userCategoryIdx: uniqueIndex('notif_pref_user_category_idx').on(table.userId, table.category),
}));

/**
 * Notifications — in-app notification store.
 */
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type', { enum: ['transactional', 'promotional', 'system'] }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['unread', 'read', 'dismissed'] }).notNull().default('unread'),
  deepLink: text('deep_link'),
  /** Source mini-app that triggered the notification (null = system-generated) */
  sourceAppId: text('source_app_id'),
  metadata: text('metadata'), // JSON
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('notif_user_idx').on(table.userId),
  typeIdx: index('notif_type_idx').on(table.type),
  statusIdx: index('notif_status_idx').on(table.status),
  dateIdx: index('notif_date_idx').on(table.createdAt),
}));

export type PushToken = typeof pushTokens.$inferSelect;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;

// =============================================================================
// PHASE 2.1 — BILL PAYMENTS VERTICAL
// =============================================================================

/**
 * Billers — catalog of available billers per category.
 * Seeded at startup; could be synced from an aggregator API.
 */
export const billers = pgTable('billers', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  category: text('category', {
    enum: ['airtime', 'data', 'electricity', 'water', 'cable_tv', 'internet', 'betting', 'government', 'insurance'],
  }).notNull(),
  country: text('country').notNull().default('NG'),
  logoUrl: text('logo_url'),
  /** Label for the customer identifier (e.g. "Phone Number", "Meter Number") */
  customerIdLabel: text('customer_id_label').notNull(),
  /** Regex to validate the customer identifier */
  customerIdPattern: text('customer_id_pattern'),
  /** Fixed amount options in minor units (JSON array), null = free input */
  fixedAmounts: text('fixed_amounts'),
  minAmount: bigint('min_amount', { mode: 'number' }), // minor units
  maxAmount: bigint('max_amount', { mode: 'number' }), // minor units
  currency: text('currency').notNull().default('NGN'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  categoryIdx: index('biller_category_idx').on(table.category),
  countryIdx: index('biller_country_idx').on(table.country),
}));

/**
 * Saved Billers — user-saved biller + customer ID combos for quick repeat payments.
 */
export const savedBillers = pgTable('saved_billers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  billerId: text('biller_id').notNull().references(() => billers.id),
  customerId: text('customer_id').notNull(),
  alias: text('alias'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('saved_biller_user_idx').on(table.userId),
  uniqueIdx: uniqueIndex('saved_biller_unique_idx').on(table.userId, table.billerId, table.customerId),
}));

/**
 * Bill Payments — transaction history for bill payments.
 */
export const billPayments = pgTable('bill_payments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  billerId: text('biller_id').notNull().references(() => billers.id),
  customerId: text('customer_id').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(), // minor units
  currency: text('currency').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'failed', 'refunded'] }).notNull().default('pending'),
  /** Aggregator transaction reference */
  providerRef: text('provider_ref'),
  /** Token returned (e.g. electricity token) */
  token: text('token'),
  receiptId: text('receipt_id').references(() => receipts.id),
  metadata: text('metadata'), // JSON
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('bill_payment_user_idx').on(table.userId),
  billerIdx: index('bill_payment_biller_idx').on(table.billerId),
  statusIdx: index('bill_payment_status_idx').on(table.status),
  dateIdx: index('bill_payment_date_idx').on(table.createdAt),
}));

/**
 * Scheduled Payments — recurring bill payments.
 */
export const scheduledPayments = pgTable('scheduled_payments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  billerId: text('biller_id').notNull().references(() => billers.id),
  customerId: text('customer_id').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  frequency: text('frequency', { enum: ['daily', 'weekly', 'monthly'] }).notNull(),
  nextRunAt: timestamp('next_run_at').notNull(),
  active: boolean('active').notNull().default(true),
  lastRunAt: timestamp('last_run_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('scheduled_payment_user_idx').on(table.userId),
  nextRunIdx: index('scheduled_payment_next_run_idx').on(table.nextRunAt),
}));

export type Biller = typeof billers.$inferSelect;
export type SavedBiller = typeof savedBillers.$inferSelect;
export type BillPayment = typeof billPayments.$inferSelect;
export type ScheduledPayment = typeof scheduledPayments.$inferSelect;

// =============================================================================
// Phase 2.2 — Transfers & Savings Vertical
// =============================================================================

/** Beneficiaries (saved transfer recipients) */
export const beneficiaries = pgTable('beneficiaries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type', { enum: ['wallet', 'bank'] }).notNull(),
  /** For wallet: recipient userId. For bank: account number */
  accountId: text('account_id').notNull(),
  bankCode: text('bank_code'),
  bankName: text('bank_name'),
  accountName: text('account_name').notNull(),
  alias: text('alias'),
  transferCount: integer('transfer_count').notNull().default(0),
  lastTransferAt: timestamp('last_transfer_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('beneficiary_user_idx').on(table.userId),
  uniqueIdx: uniqueIndex('beneficiary_unique_idx').on(table.userId, table.type, table.accountId),
}));

/** Transfers (P2P wallet + bank) */
export const transfers = pgTable('transfers', {
  id: text('id').primaryKey(),
  senderId: text('sender_id').notNull().references(() => users.id),
  recipientType: text('recipient_type', { enum: ['wallet', 'bank'] }).notNull(),
  /** For wallet: recipient userId. For bank: account number */
  recipientId: text('recipient_id').notNull(),
  bankCode: text('bank_code'),
  bankName: text('bank_name'),
  accountName: text('account_name'),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('NGN'),
  narration: text('narration'),
  status: text('status', { enum: ['pending', 'completed', 'failed', 'reversed'] }).notNull().default('pending'),
  transactionRef: text('transaction_ref').notNull(),
  receiptId: text('receipt_id'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  senderIdx: index('transfer_sender_idx').on(table.senderId),
  recipientIdx: index('transfer_recipient_idx').on(table.recipientId),
  statusIdx: index('transfer_status_idx').on(table.status),
  dateIdx: index('transfer_date_idx').on(table.createdAt),
}));

/** Savings Goals */
export const savingsGoals = pgTable('savings_goals', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  targetAmount: bigint('target_amount', { mode: 'number' }).notNull(),
  currentAmount: bigint('current_amount', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('NGN'),
  deadline: timestamp('deadline'),
  /** Whether user can withdraw before deadline */
  locked: boolean('locked').notNull().default(false),
  /** Auto-deduction frequency */
  autoDeductFrequency: text('auto_deduct_frequency', { enum: ['none', 'daily', 'weekly', 'monthly'] }).notNull().default('none'),
  autoDeductAmount: bigint('auto_deduct_amount', { mode: 'number' }),
  nextDeductAt: timestamp('next_deduct_at'),
  status: text('status', { enum: ['active', 'completed', 'withdrawn', 'cancelled'] }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userIdx: index('savings_goal_user_idx').on(table.userId),
  statusIdx: index('savings_goal_status_idx').on(table.status),
}));

/** Savings Transactions (deposits/withdrawals against goals) */
export const savingsTransactions = pgTable('savings_transactions', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').notNull().references(() => savingsGoals.id),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type', { enum: ['deposit', 'withdrawal', 'auto_deduct'] }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
  transactionRef: text('transaction_ref'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  goalIdx: index('savings_txn_goal_idx').on(table.goalId),
  userIdx: index('savings_txn_user_idx').on(table.userId),
}));

/** Ajo/Esusu Groups (rotating savings clubs) */
export const ajoGroups = pgTable('ajo_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  creatorId: text('creator_id').notNull().references(() => users.id),
  contributionAmount: bigint('contribution_amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  frequency: text('frequency', { enum: ['daily', 'weekly', 'biweekly', 'monthly'] }).notNull(),
  maxMembers: integer('max_members').notNull(),
  currentRound: integer('current_round').notNull().default(0),
  totalRounds: integer('total_rounds').notNull(),
  nextPayoutAt: timestamp('next_payout_at'),
  status: text('status', { enum: ['forming', 'active', 'completed', 'dissolved'] }).notNull().default('forming'),
  inviteCode: text('invite_code').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  creatorIdx: index('ajo_group_creator_idx').on(table.creatorId),
  statusIdx: index('ajo_group_status_idx').on(table.status),
  inviteIdx: uniqueIndex('ajo_group_invite_idx').on(table.inviteCode),
}));

/** Ajo/Esusu Group Members */
export const ajoMembers = pgTable('ajo_members', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => ajoGroups.id),
  userId: text('user_id').notNull().references(() => users.id),
  position: integer('position').notNull(),
  status: text('status', { enum: ['active', 'defaulted', 'removed'] }).notNull().default('active'),
  totalContributed: bigint('total_contributed', { mode: 'number' }).notNull().default(0),
  totalReceived: bigint('total_received', { mode: 'number' }).notNull().default(0),
  joinedAt: timestamp('joined_at').notNull(),
}, (table) => ({
  groupIdx: index('ajo_member_group_idx').on(table.groupId),
  userIdx: index('ajo_member_user_idx').on(table.userId),
  uniqueIdx: uniqueIndex('ajo_member_unique_idx').on(table.groupId, table.userId),
}));

/** Ajo/Esusu Contributions */
export const ajoContributions = pgTable('ajo_contributions', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => ajoGroups.id),
  memberId: text('member_id').notNull().references(() => ajoMembers.id),
  round: integer('round').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  status: text('status', { enum: ['pending', 'paid', 'missed'] }).notNull().default('pending'),
  transactionRef: text('transaction_ref'),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  groupRoundIdx: index('ajo_contrib_group_round_idx').on(table.groupId, table.round),
  memberIdx: index('ajo_contrib_member_idx').on(table.memberId),
}));

export type Beneficiary = typeof beneficiaries.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type SavingsGoal = typeof savingsGoals.$inferSelect;
export type SavingsTransaction = typeof savingsTransactions.$inferSelect;
export type AjoGroup = typeof ajoGroups.$inferSelect;
export type AjoMember = typeof ajoMembers.$inferSelect;
export type AjoContribution = typeof ajoContributions.$inferSelect;

// =============================================================================
// Phase 2.3 — Health Access
// =============================================================================

/** Health Providers (doctors, pharmacies, hospitals, labs) */
export const healthProviders = pgTable('health_providers', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['doctor', 'pharmacy', 'hospital', 'lab'] }).notNull(),
  name: text('name').notNull(),
  specialty: text('specialty'), // for doctors: general_practice, dermatology, etc.
  bio: text('bio'),
  photoUrl: text('photo_url'),
  qualifications: text('qualifications'), // JSON array
  licenseNumber: text('license_number'),
  consultationFee: bigint('consultation_fee', { mode: 'number' }), // minor units
  currency: text('currency').notNull().default('NGN'),
  country: text('country').notNull().default('NG'),
  city: text('city'),
  address: text('address'),
  latitude: text('latitude'),
  longitude: text('longitude'),
  phone: text('phone'),
  rating: integer('rating').default(0), // 0-500 (stored as x100)
  reviewCount: integer('review_count').default(0),
  languagesSpoken: text('languages_spoken'), // JSON array
  gender: text('gender', { enum: ['male', 'female', 'other'] }),
  availableNow: boolean('available_now').default(false),
  operatingHours: text('operating_hours'), // JSON
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  typeIdx: index('health_provider_type_idx').on(table.type),
  specialtyIdx: index('health_provider_specialty_idx').on(table.specialty),
  countryIdx: index('health_provider_country_idx').on(table.country),
  cityIdx: index('health_provider_city_idx').on(table.city),
}));

/** Appointments */
export const appointments = pgTable('appointments', {
  id: text('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => healthProviders.id),
  type: text('type', { enum: ['consultation', 'lab_test', 'follow_up'] }).notNull(),
  scheduledAt: timestamp('scheduled_at').notNull(),
  duration: integer('duration').notNull().default(30), // minutes
  status: text('status', { enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'] }).notNull().default('pending'),
  consultationFee: bigint('consultation_fee', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  transactionRef: text('transaction_ref'),
  notes: text('notes'),
  cancellationReason: text('cancellation_reason'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  patientIdx: index('appointment_patient_idx').on(table.patientId),
  providerIdx: index('appointment_provider_idx').on(table.providerId),
  statusIdx: index('appointment_status_idx').on(table.status),
  scheduleIdx: index('appointment_schedule_idx').on(table.scheduledAt),
}));

/** Consultations (live chat sessions linked to appointments) */
export const consultations = pgTable('consultations', {
  id: text('id').primaryKey(),
  appointmentId: text('appointment_id').notNull().references(() => appointments.id),
  patientId: text('patient_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => healthProviders.id),
  status: text('status', { enum: ['active', 'ended'] }).notNull().default('active'),
  startedAt: timestamp('started_at').notNull(),
  endedAt: timestamp('ended_at'),
  summary: text('summary'), // doctor's post-consultation notes
}, (table) => ({
  appointmentIdx: index('consultation_appt_idx').on(table.appointmentId),
  patientIdx: index('consultation_patient_idx').on(table.patientId),
}));

/** Consultation Messages */
export const consultationMessages = pgTable('consultation_messages', {
  id: text('id').primaryKey(),
  consultationId: text('consultation_id').notNull().references(() => consultations.id),
  senderId: text('sender_id').notNull(), // patient or provider
  senderRole: text('sender_role', { enum: ['patient', 'doctor'] }).notNull(),
  type: text('type', { enum: ['text', 'image', 'voice_note', 'file'] }).notNull(),
  content: text('content').notNull(),
  mediaUrl: text('media_url'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  consultationIdx: index('msg_consultation_idx').on(table.consultationId),
  senderIdx: index('msg_sender_idx').on(table.senderId),
}));

/** Prescriptions */
export const prescriptions = pgTable('prescriptions', {
  id: text('id').primaryKey(),
  consultationId: text('consultation_id').notNull().references(() => consultations.id),
  patientId: text('patient_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => healthProviders.id),
  diagnosis: text('diagnosis').notNull(),
  notes: text('notes'),
  status: text('status', { enum: ['active', 'fulfilled', 'expired'] }).notNull().default('active'),
  receiptId: text('receipt_id'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  consultationIdx: index('prescription_consultation_idx').on(table.consultationId),
  patientIdx: index('prescription_patient_idx').on(table.patientId),
}));

/** Prescription Items (individual medicines) */
export const prescriptionItems = pgTable('prescription_items', {
  id: text('id').primaryKey(),
  prescriptionId: text('prescription_id').notNull().references(() => prescriptions.id),
  medicineName: text('medicine_name').notNull(),
  dosage: text('dosage').notNull(),
  frequency: text('frequency').notNull(), // e.g. "twice daily"
  duration: text('duration').notNull(), // e.g. "7 days"
  quantity: integer('quantity').notNull(),
  notes: text('notes'),
}, (table) => ({
  prescriptionIdx: index('rx_item_prescription_idx').on(table.prescriptionId),
}));

/** Pharmacy Orders */
export const pharmacyOrders = pgTable('pharmacy_orders', {
  id: text('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => users.id),
  pharmacyId: text('pharmacy_id').notNull().references(() => healthProviders.id),
  prescriptionId: text('prescription_id').references(() => prescriptions.id),
  status: text('status', { enum: ['pending', 'confirmed', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'] }).notNull().default('pending'),
  deliveryMethod: text('delivery_method', { enum: ['pickup', 'delivery'] }).notNull(),
  deliveryAddress: text('delivery_address'),
  subtotal: bigint('subtotal', { mode: 'number' }).notNull(), // minor units
  deliveryFee: bigint('delivery_fee', { mode: 'number' }).notNull().default(0),
  total: bigint('total', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  transactionRef: text('transaction_ref'),
  receiptId: text('receipt_id'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  patientIdx: index('pharmacy_order_patient_idx').on(table.patientId),
  pharmacyIdx: index('pharmacy_order_pharmacy_idx').on(table.pharmacyId),
  statusIdx: index('pharmacy_order_status_idx').on(table.status),
}));

/** Pharmacy Order Items */
export const pharmacyOrderItems = pgTable('pharmacy_order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => pharmacyOrders.id),
  medicineName: text('medicine_name').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: bigint('unit_price', { mode: 'number' }).notNull(), // minor units
  total: bigint('total', { mode: 'number' }).notNull(),
}, (table) => ({
  orderIdx: index('pharmacy_item_order_idx').on(table.orderId),
}));

/** Insurance Plans */
export const insurancePlans = pgTable('insurance_plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(), // e.g. NHIA, NHIF, HMO name
  type: text('type', { enum: ['public', 'private'] }).notNull(),
  country: text('country').notNull().default('NG'),
  coverageLevel: text('coverage_level', { enum: ['basic', 'standard', 'premium'] }).notNull(),
  premiumAmount: bigint('premium_amount', { mode: 'number' }).notNull(), // minor units
  premiumFrequency: text('premium_frequency', { enum: ['monthly', 'quarterly', 'annual'] }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  benefits: text('benefits').notNull(), // JSON array of covered items
  maxCoverage: bigint('max_coverage', { mode: 'number' }), // annual max in minor units
  waitingPeriodDays: integer('waiting_period_days').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  countryIdx: index('insurance_plan_country_idx').on(table.country),
  typeIdx: index('insurance_plan_type_idx').on(table.type),
}));

/** User Insurance Enrollments */
export const userInsurance = pgTable('user_insurance', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  planId: text('plan_id').notNull().references(() => insurancePlans.id),
  enrollmentNumber: text('enrollment_number').notNull().unique(),
  status: text('status', { enum: ['active', 'lapsed', 'cancelled'] }).notNull().default('active'),
  startDate: timestamp('start_date').notNull(),
  nextPremiumDate: timestamp('next_premium_date'),
  totalPaid: bigint('total_paid', { mode: 'number' }).notNull().default(0),
  totalClaimed: bigint('total_claimed', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userIdx: index('user_insurance_user_idx').on(table.userId),
  planIdx: index('user_insurance_plan_idx').on(table.planId),
  statusIdx: index('user_insurance_status_idx').on(table.status),
}));

/** Insurance Claims */
export const insuranceClaims = pgTable('insurance_claims', {
  id: text('id').primaryKey(),
  enrollmentId: text('enrollment_id').notNull().references(() => userInsurance.id),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type', { enum: ['consultation', 'pharmacy', 'lab_test', 'hospitalization', 'other'] }).notNull(),
  description: text('description').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(), // minor units
  currency: text('currency').notNull().default('NGN'),
  status: text('status', { enum: ['submitted', 'under_review', 'approved', 'rejected', 'paid'] }).notNull().default('submitted'),
  evidenceUrls: text('evidence_urls'), // JSON array of uploaded file URLs
  reviewNotes: text('review_notes'),
  approvedAmount: bigint('approved_amount', { mode: 'number' }),
  appointmentId: text('appointment_id'),
  submittedAt: timestamp('submitted_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
}, (table) => ({
  enrollmentIdx: index('claim_enrollment_idx').on(table.enrollmentId),
  userIdx: index('claim_user_idx').on(table.userId),
  statusIdx: index('claim_status_idx').on(table.status),
}));

/** Lab Test Catalog */
export const labTests = pgTable('lab_tests', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(), // e.g. blood_work, imaging, pathology
  description: text('description'),
  price: bigint('price', { mode: 'number' }).notNull(), // minor units
  currency: text('currency').notNull().default('NGN'),
  turnaroundHours: integer('turnaround_hours').notNull(), // expected result time
  requiresFasting: boolean('requires_fasting').default(false),
  sampleType: text('sample_type'), // blood, urine, etc.
  active: boolean('active').notNull().default(true),
}, (table) => ({
  categoryIdx: index('lab_test_category_idx').on(table.category),
}));

/** Lab Bookings */
export const labBookings = pgTable('lab_bookings', {
  id: text('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => users.id),
  labId: text('lab_id').notNull().references(() => healthProviders.id),
  testId: text('test_id').notNull().references(() => labTests.id),
  appointmentId: text('appointment_id').references(() => appointments.id),
  prescriptionId: text('prescription_id').references(() => prescriptions.id),
  status: text('status', { enum: ['booked', 'sample_collected', 'processing', 'results_ready', 'cancelled'] }).notNull().default('booked'),
  scheduledAt: timestamp('scheduled_at').notNull(),
  resultSummary: text('result_summary'),
  resultUrl: text('result_url'),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  transactionRef: text('transaction_ref'),
  receiptId: text('receipt_id'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  patientIdx: index('lab_booking_patient_idx').on(table.patientId),
  labIdx: index('lab_booking_lab_idx').on(table.labId),
  testIdx: index('lab_booking_test_idx').on(table.testId),
  statusIdx: index('lab_booking_status_idx').on(table.status),
}));

export type HealthProvider = typeof healthProviders.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Consultation = typeof consultations.$inferSelect;
export type ConsultationMessage = typeof consultationMessages.$inferSelect;
export type Prescription = typeof prescriptions.$inferSelect;
export type PrescriptionItem = typeof prescriptionItems.$inferSelect;
export type PharmacyOrder = typeof pharmacyOrders.$inferSelect;
export type PharmacyOrderItem = typeof pharmacyOrderItems.$inferSelect;
export type InsurancePlan = typeof insurancePlans.$inferSelect;
export type UserInsurance = typeof userInsurance.$inferSelect;
export type InsuranceClaim = typeof insuranceClaims.$inferSelect;
export type LabTest = typeof labTests.$inferSelect;
export type LabBooking = typeof labBookings.$inferSelect;

// =============================================================================
// PHASE 2.4 — ENERGY TOP-UP
// =============================================================================

/** Energy Providers (Discos, Solar companies, Gas suppliers) */
export const energyProviders = pgTable('energy_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['electricity', 'solar', 'gas'] }).notNull(),
  country: text('country').notNull().default('NG'),
  logo: text('logo'), // URL or null
  serviceCharge: bigint('service_charge', { mode: 'number' }).notNull().default(0), // minor units flat fee
  vatRate: integer('vat_rate').notNull().default(750), // basis points (7.5% = 750)
  meterTypes: text('meter_types'), // JSON: ["prepaid","postpaid"]
  active: boolean('active').notNull().default(true),
}, (table) => ({
  typeIdx: index('energy_provider_type_idx').on(table.type),
  countryIdx: index('energy_provider_country_idx').on(table.country),
}));

/** Saved Meters / Devices */
export const savedMeters = pgTable('saved_meters', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => energyProviders.id),
  type: text('type', { enum: ['electricity', 'solar', 'gas'] }).notNull(),
  meterNumber: text('meter_number').notNull(),
  meterType: text('meter_type'), // prepaid / postpaid
  customerName: text('customer_name'),
  address: text('address'),
  alias: text('alias'), // user-friendly label
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('saved_meter_user_idx').on(table.userId),
  providerIdx: index('saved_meter_provider_idx').on(table.providerId),
}));

/** Energy Purchases (electricity tokens, solar payments, gas orders) */
export const energyPurchases = pgTable('energy_purchases', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => energyProviders.id),
  type: text('type', { enum: ['electricity', 'solar', 'gas'] }).notNull(),
  meterNumber: text('meter_number'),
  meterType: text('meter_type'),
  customerName: text('customer_name'),
  // Pricing breakdown
  amount: bigint('amount', { mode: 'number' }).notNull(), // base amount (minor units)
  serviceCharge: bigint('service_charge', { mode: 'number' }).notNull().default(0),
  vat: bigint('vat', { mode: 'number' }).notNull().default(0),
  total: bigint('total', { mode: 'number' }).notNull(), // amount + serviceCharge + vat
  currency: text('currency').notNull().default('NGN'),
  // Electricity-specific
  token: text('token'), // electricity token number
  units: text('units'), // kWh purchased
  tariffClass: text('tariff_class'),
  // Solar-specific
  deviceSerial: text('device_serial'),
  daysUnlocked: integer('days_unlocked'),
  // Gas-specific
  cylinderSize: text('cylinder_size'), // e.g. "12.5kg"
  vendorId: text('vendor_id'),
  deliveryMethod: text('delivery_method'), // pickup / delivery
  deliveryAddress: text('delivery_address'),
  // Common
  status: text('status', { enum: ['pending', 'completed', 'failed', 'refunded'] }).notNull().default('pending'),
  transactionRef: text('transaction_ref'),
  receiptId: text('receipt_id'),
  metadata: text('metadata'), // JSON
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('energy_purchase_user_idx').on(table.userId),
  providerIdx: index('energy_purchase_provider_idx').on(table.providerId),
  typeIdx: index('energy_purchase_type_idx').on(table.type),
  statusIdx: index('energy_purchase_status_idx').on(table.status),
}));

/** Gas Vendors */
export const gasVendors = pgTable('gas_vendors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  city: text('city').notNull(),
  country: text('country').notNull().default('NG'),
  latitude: text('latitude'),
  longitude: text('longitude'),
  phone: text('phone'),
  rating: integer('rating').default(0), // 0-500 (x100)
  // Pricing per cylinder size (minor units)
  price3kg: bigint('price_3kg', { mode: 'number' }),
  price6kg: bigint('price_6kg', { mode: 'number' }),
  price12kg: bigint('price_12_5kg', { mode: 'number' }),
  price25kg: bigint('price_25kg', { mode: 'number' }),
  price50kg: bigint('price_50kg', { mode: 'number' }),
  deliveryFee: bigint('delivery_fee', { mode: 'number' }).default(0),
  offersDelivery: boolean('offers_delivery').default(false),
  active: boolean('active').notNull().default(true),
}, (table) => ({
  cityIdx: index('gas_vendor_city_idx').on(table.city),
  countryIdx: index('gas_vendor_country_idx').on(table.country),
}));

/** Solar Devices — tracks pay-as-you-go SHS ownership progress */
export const solarDevices = pgTable('solar_devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().references(() => energyProviders.id),
  deviceSerial: text('device_serial').notNull(),
  deviceModel: text('device_model'),
  totalCost: bigint('total_cost', { mode: 'number' }).notNull(), // full ownership price (minor units)
  totalPaid: bigint('total_paid', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('NGN'),
  activeUntil: timestamp('active_until'), // current unlock expiry
  status: text('status', { enum: ['active', 'locked', 'owned'] }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  userIdx: index('solar_device_user_idx').on(table.userId),
  serialIdx: index('solar_device_serial_idx').on(table.deviceSerial),
}));

export type EnergyProvider = typeof energyProviders.$inferSelect;
export type SavedMeter = typeof savedMeters.$inferSelect;
export type EnergyPurchase = typeof energyPurchases.$inferSelect;
export type GasVendor = typeof gasVendors.$inferSelect;
export type SolarDevice = typeof solarDevices.$inferSelect;

// =============================================================================
// PHASE 2.5 — TRANSPORT TICKETING
// =============================================================================

/** Transport Operators (BRT authorities, ferry companies, rail, ride-hail partners) */
export const transportOperators = pgTable('transport_operators', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['brt', 'bus', 'ferry', 'rail', 'ridehail'] }).notNull(),
  country: text('country').notNull().default('NG'),
  city: text('city').notNull(),
  logo: text('logo'),
  website: text('website'),
  active: boolean('active').notNull().default(true),
}, (table) => ({
  typeIdx: index('transport_op_type_idx').on(table.type),
  cityIdx: index('transport_op_city_idx').on(table.city),
}));

/** Transport Routes (origin → destination per operator) */
export const transportRoutes = pgTable('transport_routes', {
  id: text('id').primaryKey(),
  operatorId: text('operator_id').notNull().references(() => transportOperators.id),
  name: text('name').notNull(), // e.g. "CMS ↔ Oshodi BRT Corridor"
  origin: text('origin').notNull(),
  destination: text('destination').notNull(),
  stops: text('stops'), // JSON array of stop names
  distanceKm: integer('distance_km'),
  durationMins: integer('duration_mins').notNull(),
  /** JSON: { single, return, day_pass, weekly_pass } amounts in minor units */
  prices: text('prices').notNull(),
  currency: text('currency').notNull().default('NGN'),
  active: boolean('active').notNull().default(true),
}, (table) => ({
  operatorIdx: index('transport_route_operator_idx').on(table.operatorId),
}));

/** Transport Schedules (departure slots for a route) */
export const transportSchedules = pgTable('transport_schedules', {
  id: text('id').primaryKey(),
  routeId: text('route_id').notNull().references(() => transportRoutes.id),
  departureTime: timestamp('departure_time').notNull(),
  arrivalTime: timestamp('arrival_time').notNull(),
  capacity: integer('capacity').notNull().default(50),
  availableSeats: integer('available_seats').notNull().default(50),
  platform: text('platform'),
  status: text('status', { enum: ['scheduled', 'delayed', 'cancelled', 'departed'] }).notNull().default('scheduled'),
  delayMins: integer('delay_mins').notNull().default(0),
}, (table) => ({
  routeIdx: index('schedule_route_idx').on(table.routeId),
  departureIdx: index('schedule_departure_idx').on(table.departureTime),
  statusIdx: index('schedule_status_idx').on(table.status),
}));

/** Transport Tickets (purchased by users) */
export const transportTickets = pgTable('transport_tickets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  operatorId: text('operator_id').notNull().references(() => transportOperators.id),
  routeId: text('route_id').notNull().references(() => transportRoutes.id),
  scheduleId: text('schedule_id').references(() => transportSchedules.id),
  ticketType: text('ticket_type', { enum: ['single', 'return', 'day_pass', 'weekly_pass'] }).notNull(),
  adultCount: integer('adult_count').notNull().default(1),
  childCount: integer('child_count').notNull().default(0),
  unitPrice: bigint('unit_price', { mode: 'number' }).notNull(), // minor units
  total: bigint('total', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  /** JSON blob used to render QR code: { ticketId, userId, routeId, validUntil, checksum } */
  qrData: text('qr_data').notNull(),
  status: text('status', { enum: ['active', 'used', 'expired', 'refunded'] }).notNull().default('active'),
  validFrom: timestamp('valid_from').notNull(),
  validUntil: timestamp('valid_until').notNull(),
  usedAt: timestamp('used_at'),
  transactionRef: text('transaction_ref').notNull(),
  receiptId: text('receipt_id'),
  metadata: text('metadata'), // JSON
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  userIdx: index('ticket_user_idx').on(table.userId),
  operatorIdx: index('ticket_operator_idx').on(table.operatorId),
  routeIdx: index('ticket_route_idx').on(table.routeId),
  statusIdx: index('ticket_status_idx').on(table.status),
  validUntilIdx: index('ticket_valid_until_idx').on(table.validUntil),
}));

/** Ride-Hail Partners (Bolt, Uber, local operators — for aggregation/deep-link) */
export const ridehailPartners = pgTable('ridehail_partners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country').notNull().default('NG'),
  appDeepLink: text('app_deep_link'), // e.g. bolt://...
  webUrl: text('web_url'),
  logoUrl: text('logo_url'),
  /** Whether in-app payment via Apex wallet is supported */
  supportsInAppPayment: boolean('supports_in_app_payment').default(false),
  active: boolean('active').notNull().default(true),
}, (table) => ({
  countryIdx: index('ridehail_partner_country_idx').on(table.country),
}));

export type TransportOperator = typeof transportOperators.$inferSelect;
export type TransportRoute = typeof transportRoutes.$inferSelect;
export type TransportSchedule = typeof transportSchedules.$inferSelect;
export type TransportTicket = typeof transportTickets.$inferSelect;
export type RidehailPartner = typeof ridehailPartners.$inferSelect;

// =============================================================================
// B2B — Developer-scoped wallets and KYB
// =============================================================================

/**
 * B2B Wallets — one per developer per currency
 */
export const b2bWallets = pgTable('b2b_wallets', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  currency: text('currency').notNull().default('NGN'),
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  availableBalance: bigint('available_balance', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['active', 'frozen', 'closed'] }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devCurrencyIdx: uniqueIndex('b2b_wallet_dev_currency_idx').on(table.developerId, table.currency),
}));

/**
 * B2B Transactions — every credit/debit on a b2b wallet
 */
export const b2bTransactions = pgTable('b2b_transactions', {
  id: text('id').primaryKey(),
  walletId: text('wallet_id').notNull().references(() => b2bWallets.id),
  developerId: text('developer_id').notNull().references(() => developers.id),
  type: text('type', {
    enum: ['fund', 'withdraw', 'transfer', 'fee', 'refund'],
  }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'failed', 'reversed'] }).notNull().default('completed'),
  description: text('description'),
  reference: text('reference').notNull().unique(),
  metadata: text('metadata'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  walletIdx: index('b2b_txn_wallet_idx').on(table.walletId),
  devIdx: index('b2b_txn_dev_idx').on(table.developerId),
  statusIdx: index('b2b_txn_status_idx').on(table.status),
  refIdx: uniqueIndex('b2b_txn_ref_idx').on(table.reference),
}));

/**
 * B2B KYB Records — business verification for developers
 */
export const b2bKybRecords = pgTable('b2b_kyb_records', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  businessName: text('business_name').notNull(),
  registrationNumber: text('registration_number'),
  taxId: text('tax_id'),
  country: text('country').notNull().default('NG'),
  businessType: text('business_type', {
    enum: ['sole_proprietor', 'llc', 'plc', 'ngo', 'cooperative'],
  }),
  status: text('status', {
    enum: ['pending', 'submitted', 'approved', 'rejected'],
  }).notNull().default('pending'),
  tier: integer('tier').notNull().default(1),
  rejectionReason: text('rejection_reason'),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('b2b_kyb_dev_idx').on(table.developerId),
  statusIdx: index('b2b_kyb_status_idx').on(table.status),
}));

export type B2BWallet = typeof b2bWallets.$inferSelect;
export type B2BTransaction = typeof b2bTransactions.$inferSelect;
export type B2BKybRecord = typeof b2bKybRecords.$inferSelect;

// =============================================================================
// B2B — Fleet & Fuel Management
// =============================================================================

/** Vehicles registered under a developer/organisation */
export const fleetVehicles = pgTable('fleet_vehicles', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  plateNumber: text('plate_number').notNull(),
  make: text('make').notNull(),
  model: text('model').notNull(),
  year: integer('year'),
  fuelType: text('fuel_type', { enum: ['petrol', 'diesel', 'electric', 'hybrid', 'cng'] }).notNull().default('petrol'),
  status: text('status', { enum: ['active', 'inactive', 'maintenance'] }).notNull().default('active'),
  assignedDriverName: text('assigned_driver_name'),
  assignedDriverPhone: text('assigned_driver_phone'),
  odometer: integer('odometer').notNull().default(0),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('fleet_vehicle_dev_idx').on(table.developerId),
  statusIdx: index('fleet_vehicle_status_idx').on(table.status),
  plateIdx: uniqueIndex('fleet_vehicle_plate_idx').on(table.developerId, table.plateNumber),
}));

/** Fuel cards linked to vehicles or the organisation pool */
export const fuelCards = pgTable('fuel_cards', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  vehicleId: text('vehicle_id').references(() => fleetVehicles.id),
  cardNumber: text('card_number').notNull(),
  provider: text('provider').notNull().default('Apex Fuel'),
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('NGN'),
  status: text('status', { enum: ['active', 'blocked', 'expired'] }).notNull().default('active'),
  spendLimit: bigint('spend_limit', { mode: 'number' }),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('fuel_card_dev_idx').on(table.developerId),
  vehicleIdx: index('fuel_card_vehicle_idx').on(table.vehicleId),
}));

/** Individual fuel / trip transactions */
export const fleetTransactions = pgTable('fleet_transactions', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  vehicleId: text('vehicle_id').references(() => fleetVehicles.id),
  fuelCardId: text('fuel_card_id').references(() => fuelCards.id),
  type: text('type', { enum: ['fuel', 'toll', 'maintenance', 'card_topup'] }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  litres: integer('litres'),
  pricePerLitre: bigint('price_per_litre', { mode: 'number' }),
  station: text('station'),
  location: text('location'),
  odometer: integer('odometer'),
  status: text('status', { enum: ['pending', 'completed', 'failed'] }).notNull().default('completed'),
  reference: text('reference').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  devIdx: index('fleet_txn_dev_idx').on(table.developerId),
  vehicleIdx: index('fleet_txn_vehicle_idx').on(table.vehicleId),
  typeIdx: index('fleet_txn_type_idx').on(table.type),
  dateIdx: index('fleet_txn_date_idx').on(table.createdAt),
}));

export type FleetVehicle = typeof fleetVehicles.$inferSelect;
export type FuelCard = typeof fuelCards.$inferSelect;
export type FleetTransaction = typeof fleetTransactions.$inferSelect;

// =============================================================================
// B2B — Staff Health Plans
// =============================================================================

/** Health plan tiers offered to businesses */
export const staffHealthPlans = pgTable('staff_health_plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  tier: text('tier', { enum: ['basic', 'standard', 'premium'] }).notNull().default('basic'),
  /** Monthly premium per employee in minor units */
  monthlyPremium: bigint('monthly_premium', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  coverageLimit: bigint('coverage_limit', { mode: 'number' }).notNull(),
  inpatientCover: boolean('inpatient_cover').notNull().default(true),
  outpatientCover: boolean('outpatient_cover').notNull().default(true),
  dentalCover: boolean('dental_cover').notNull().default(false),
  opticalCover: boolean('optical_cover').notNull().default(false),
  maternityBenefit: boolean('maternity_benefit').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
});

/** Employees enrolled on a plan by their employer (developer) */
export const staffEnrollments = pgTable('staff_enrollments', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  planId: text('plan_id').notNull().references(() => staffHealthPlans.id),
  employeeId: text('employee_id').notNull(),
  employeeName: text('employee_name').notNull(),
  employeeEmail: text('employee_email'),
  employeePhone: text('employee_phone'),
  dateOfBirth: text('date_of_birth'),
  gender: text('gender', { enum: ['male', 'female', 'other'] }),
  status: text('status', { enum: ['active', 'suspended', 'terminated'] }).notNull().default('active'),
  effectiveDate: timestamp('effective_date').notNull(),
  expiryDate: timestamp('expiry_date'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('staff_enroll_dev_idx').on(table.developerId),
  planIdx: index('staff_enroll_plan_idx').on(table.planId),
  empIdx: uniqueIndex('staff_enroll_emp_idx').on(table.developerId, table.employeeId),
}));

/** Health claims filed by employees */
export const staffClaims = pgTable('staff_claims', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  enrollmentId: text('enrollment_id').notNull().references(() => staffEnrollments.id),
  claimType: text('claim_type', { enum: ['inpatient', 'outpatient', 'dental', 'optical', 'maternity', 'other'] }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  approvedAmount: bigint('approved_amount', { mode: 'number' }),
  currency: text('currency').notNull().default('NGN'),
  providerName: text('provider_name'),
  diagnosisCode: text('diagnosis_code'),
  description: text('description'),
  status: text('status', { enum: ['pending', 'under_review', 'approved', 'rejected', 'paid'] }).notNull().default('pending'),
  submittedAt: timestamp('submitted_at').notNull(),
  reviewedAt: timestamp('reviewed_at'),
  paidAt: timestamp('paid_at'),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  devIdx: index('staff_claim_dev_idx').on(table.developerId),
  enrollIdx: index('staff_claim_enroll_idx').on(table.enrollmentId),
  statusIdx: index('staff_claim_status_idx').on(table.status),
}));

export type StaffHealthPlan = typeof staffHealthPlans.$inferSelect;
export type StaffEnrollment = typeof staffEnrollments.$inferSelect;
export type StaffClaim = typeof staffClaims.$inferSelect;

// ─── Cross-border Payments ────────────────────────────────────────────────────

/** Saved payout recipients (beneficiaries) per developer */
export const crossborderRecipients = pgTable('crossborder_recipients', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  alias: text('alias').notNull(),
  fullName: text('full_name').notNull(),
  country: text('country').notNull(),
  currency: text('currency').notNull(),
  bankName: text('bank_name'),
  bankCode: text('bank_code'),
  accountNumber: text('account_number').notNull(),
  routingNumber: text('routing_number'),
  swiftCode: text('swift_code'),
  ibanNumber: text('iban_number'),
  mobileWalletProvider: text('mobile_wallet_provider'),
  mobileWalletNumber: text('mobile_wallet_number'),
  type: text('type', { enum: ['bank_account', 'mobile_wallet', 'cash_pickup'] }).notNull().default('bank_account'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('xborder_recipient_dev_idx').on(table.developerId),
  countryIdx: index('xborder_recipient_country_idx').on(table.country),
}));

/** Individual cross-border transfer records */
export const crossborderTransfers = pgTable('crossborder_transfers', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  recipientId: text('recipient_id').references(() => crossborderRecipients.id),
  reference: text('reference').notNull().unique(),
  /** Amount sent in source currency minor units */
  sendAmount: bigint('send_amount', { mode: 'number' }).notNull(),
  sendCurrency: text('send_currency').notNull(),
  /** Amount received in destination currency minor units */
  receiveAmount: bigint('receive_amount', { mode: 'number' }).notNull(),
  receiveCurrency: text('receive_currency').notNull(),
  exchangeRate: text('exchange_rate').notNull(),
  fee: bigint('fee', { mode: 'number' }).notNull().default(0),
  feeCurrency: text('fee_currency').notNull().default('NGN'),
  recipientName: text('recipient_name').notNull(),
  recipientCountry: text('recipient_country').notNull(),
  recipientAccount: text('recipient_account').notNull(),
  purpose: text('purpose', { enum: ['business_payment', 'salary', 'invoice', 'supplier', 'family_support', 'other'] }).notNull().default('business_payment'),
  narration: text('narration'),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'] }).notNull().default('pending'),
  failureReason: text('failure_reason'),
  initiatedAt: timestamp('initiated_at').notNull(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  devIdx: index('xborder_transfer_dev_idx').on(table.developerId),
  statusIdx: index('xborder_transfer_status_idx').on(table.status),
  refIdx: uniqueIndex('xborder_transfer_ref_idx').on(table.reference),
}));

export type CrossborderRecipient = typeof crossborderRecipients.$inferSelect;
export type CrossborderTransfer = typeof crossborderTransfers.$inferSelect;

// ─── Collections & Invoicing ─────────────────────────────────────────────────

/** Individual invoices raised by a developer against their customers */
export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  invoiceNumber: text('invoice_number').notNull(),
  /** Free-form customer name — not linked to identity users */
  customerName: text('customer_name').notNull(),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  customerAddress: text('customer_address'),
  currency: text('currency').notNull().default('NGN'),
  subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
  taxRate: integer('tax_rate').notNull().default(0),   // basis points e.g. 750 = 7.5%
  taxAmount: bigint('tax_amount', { mode: 'number' }).notNull().default(0),
  discountAmount: bigint('discount_amount', { mode: 'number' }).notNull().default(0),
  total: bigint('total', { mode: 'number' }).notNull(),
  amountPaid: bigint('amount_paid', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled'] }).notNull().default('draft'),
  notes: text('notes'),
  paymentLink: text('payment_link'),
  issuedAt: timestamp('issued_at'),
  dueAt: timestamp('due_at'),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('invoice_dev_idx').on(table.developerId),
  statusIdx: index('invoice_status_idx').on(table.status),
  numIdx: uniqueIndex('invoice_num_idx').on(table.developerId, table.invoiceNumber),
}));

/** Line items belonging to an invoice */
export const invoiceLineItems = pgTable('invoice_line_items', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),   // quantity * unitPrice
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  invoiceIdx: index('line_item_invoice_idx').on(table.invoiceId),
}));

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;

// ─── Embedded Finance ────────────────────────────────────────────────────────

/**
 * Customer wallets issued by a developer under their business branding.
 * Each developer can issue wallets to their own end-customers.
 */
export const embeddedWallets = pgTable('embedded_wallets', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  /** Unique identifier the developer uses for this customer in their own system */
  externalCustomerId: text('external_customer_id').notNull(),
  customerName: text('customer_name').notNull(),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  currency: text('currency').notNull().default('NGN'),
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  ledgerBalance: bigint('ledger_balance', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['active', 'frozen', 'closed'] }).notNull().default('active'),
  tier: text('tier', { enum: ['basic', 'standard', 'premium'] }).notNull().default('basic'),
  dailyTxnLimit: bigint('daily_txn_limit', { mode: 'number' }).notNull().default(50000000),  // ₦500,000
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('emb_wallet_dev_idx').on(table.developerId),
  extCustIdx: uniqueIndex('emb_wallet_ext_cust_idx').on(table.developerId, table.externalCustomerId),
}));

/**
 * Ledger entries for embedded wallets.
 * Every credit or debit is recorded here for full auditability.
 */
export const embeddedTransactions = pgTable('embedded_transactions', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  walletId: text('wallet_id').notNull().references(() => embeddedWallets.id),
  type: text('type', { enum: ['credit', 'debit', 'transfer_in', 'transfer_out', 'fee', 'reversal'] }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('NGN'),
  balanceBefore: bigint('balance_before', { mode: 'number' }).notNull(),
  balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
  reference: text('reference').notNull().unique(),
  narration: text('narration'),
  metadata: text('metadata'),  // JSON blob for arbitrary developer data
  status: text('status', { enum: ['pending', 'completed', 'failed', 'reversed'] }).notNull().default('completed'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  devIdx: index('emb_txn_dev_idx').on(table.developerId),
  walletIdx: index('emb_txn_wallet_idx').on(table.walletId),
  refIdx: uniqueIndex('emb_txn_ref_idx').on(table.reference),
}));

/**
 * Webhooks registered by developers to receive real-time event notifications.
 */
export const embeddedWebhooks = pgTable('embedded_webhooks', {
  id: text('id').primaryKey(),
  developerId: text('developer_id').notNull().references(() => developers.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events').notNull(),  // JSON array of event types
  isActive: boolean('is_active').notNull().default(true),
  lastDeliveredAt: timestamp('last_delivered_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  devIdx: index('emb_webhook_dev_idx').on(table.developerId),
}));

export type EmbeddedWallet = typeof embeddedWallets.$inferSelect;
export type EmbeddedTransaction = typeof embeddedTransactions.$inferSelect;
export type EmbeddedWebhook = typeof embeddedWebhooks.$inferSelect;

/**
 * Preview Packages - temporary preview packages uploaded via `apex preview --upload`
 */
export const previewPackages = pgTable('preview_packages', {
  id: text('id').primaryKey(),                                      // nanoid
  token: text('token').notNull().unique(),                          // preview token from CLI
  appId: text('app_id').notNull(),                                  // reverse-domain app ID
  developerId: text('developer_id').references(() => developers.id), // null = anonymous
  packagePath: text('package_path').notNull(),                       // absolute FS path to .map file
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  tokenIdx: uniqueIndex('preview_token_idx').on(table.token),
  expiresIdx: index('preview_expires_idx').on(table.expiresAt),
}));

export type PreviewPackage = typeof previewPackages.$inferSelect;
