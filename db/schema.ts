import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const walletLinks = sqliteTable('wallet_links', {
  identityId: text('identity_id').primaryKey(),
  wallet: text('wallet').notNull().unique(),
  linkedAt: text('linked_at').notNull(),
});

export const challenges = sqliteTable('challenges', {
  id: text('id').primaryKey(),
  identityId: text('identity_id').notNull(),
  wallet: text('wallet').notNull(),
  purpose: text('purpose').notNull(),
  dealId: text('deal_id'),
  version: integer('version'),
  termsHash: text('terms_hash'),
  message: text('message').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  createdAt: integer('created_at').notNull(),
});

export const deals = sqliteTable('deals', {
  id: text('id').primaryKey(),
  ownerIdentity: text('owner_identity').notNull(),
  brandWallet: text('brand_wallet').notNull(),
  creatorWallet: text('creator_wallet').notNull(),
  version: integer('version').notNull().default(1),
  termsJson: text('terms_json').notNull(),
  termsHash: text('terms_hash').notNull(),
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('deals_brand_idx').on(table.brandWallet), index('deals_creator_idx').on(table.creatorWallet)]);

export const dealApprovals = sqliteTable('deal_approvals', {
  dealId: text('deal_id').notNull().references(() => deals.id),
  version: integer('version').notNull(),
  wallet: text('wallet').notNull(),
  termsHash: text('terms_hash').notNull(),
  signature: text('signature').notNull(),
  approvedAt: text('approved_at').notNull(),
}, (table) => [primaryKey({ columns: [table.dealId, table.version, table.wallet] })]);

export const paymentIntents = sqliteTable('payment_intents', {
  id: text('id').primaryKey(),
  dealId: text('deal_id').notNull().unique().references(() => deals.id),
  identityId: text('identity_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  status: text('status').notNull().default('created'),
  txSignature: text('tx_signature'),
  eventIndex: integer('event_index'),
  outputIndex: integer('output_index'),
  disclosureCiphertext: text('disclosure_ciphertext'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('payment_intents_identity_key_idx').on(table.identityId, table.idempotencyKey)]);

export const receipts = sqliteTable('receipts', {
  id: text('id').primaryKey(),
  dealId: text('deal_id').notNull().unique().references(() => deals.id),
  intentId: text('intent_id').notNull().unique().references(() => paymentIntents.id),
  network: text('network').notNull(),
  txSignature: text('tx_signature').notNull(),
  recordJson: text('record_json').notNull(),
  verifiedAt: text('verified_at').notNull(),
}, (table) => [uniqueIndex('receipts_network_signature_idx').on(table.network, table.txSignature)]);

export const rateLimits = sqliteTable('rate_limits', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
