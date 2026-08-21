import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { rejectionReasons } from './rejectionReasons.js';

export const app = pgSchema('app');

export const customers = app.table(
  'customers',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('customers_id_not_blank', sql`length(btrim(${table.id})) > 0`),
  ],
);

export const ingestSources = app.table(
  'ingest_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentSha256: text('content_sha256').notNull(),
    sourceUri: text('source_uri').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('ingest_sources_content_sha256_idx').on(table.contentSha256),
    check(
      'ingest_sources_sha256_format',
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('ingest_sources_byte_size_nonnegative', sql`${table.byteSize} >= 0`),
  ],
);

export const usageEvents = app.table(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => ingestSources.id, { onDelete: 'restrict' }),
    sourceIndex: integer('source_index').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    endpoint: text('endpoint'),
    userEmail: text('user_email'),
    plan: text('plan'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms'),
    status: text('status'),
    metadata: jsonb('metadata').notNull().default({}),
    ingestHash: text('ingest_hash').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('usage_events_customer_occurred_idx').on(
      table.customerId,
      table.occurredAt,
    ),
    index('usage_events_occurred_idx').on(table.occurredAt),
    uniqueIndex('usage_events_ingest_hash_idx').on(table.ingestHash),
    check(
      'usage_events_ingest_hash_format',
      sql`${table.ingestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'usage_events_customer_not_blank',
      sql`length(btrim(${table.customerId})) > 0`,
    ),
    check(
      'usage_events_event_type_not_blank',
      sql`length(btrim(${table.eventType})) > 0`,
    ),
    check(
      'usage_events_source_index_nonnegative',
      sql`${table.sourceIndex} >= 0`,
    ),
    check(
      'usage_events_duration_nonnegative',
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
  ],
);

export const ingestRejections = app.table(
  'ingest_rejections',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => ingestSources.id, { onDelete: 'restrict' }),
    sourceIndex: integer('source_index').notNull(),
    raw: jsonb('raw').notNull(),
    reason: text('reason').notNull(),
    rejectionHash: text('rejection_hash').notNull(),
    rejectedAt: timestamp('rejected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('ingest_rejections_hash_idx').on(table.rejectionHash),
    check(
      'ingest_rejections_source_index_nonnegative',
      sql`${table.sourceIndex} >= 0`,
    ),
    check(
      'ingest_rejections_reason_valid',
      sql`${table.reason} IN (${sql.raw(
        rejectionReasons.map((reason) => `'${reason}'`).join(', '),
      )})`,
    ),
    check(
      'ingest_rejections_hash_format',
      sql`${table.rejectionHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
