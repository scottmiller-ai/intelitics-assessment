import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    sourceVersion: text('source_version'),
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

export const ingestSourceProcessings = app.table(
  'ingest_source_processings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => ingestSources.id, { onDelete: 'restrict' }),
    normalizationPolicyVersion: integer(
      'normalization_policy_version',
    ).notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastForced: boolean('last_forced').notNull().default(false),
    acceptedCount: integer('accepted_count'),
    duplicateCount: integer('duplicate_count'),
    rejectedCount: integer('rejected_count'),
    errorCode: text('error_code'),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('ingest_source_processings_source_policy_unique').on(
      table.sourceId,
      table.normalizationPolicyVersion,
    ),
    check(
      'ingest_source_processings_policy_positive',
      sql`${table.normalizationPolicyVersion} > 0`,
    ),
    check(
      'ingest_source_processings_status_valid',
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check(
      'ingest_source_processings_attempt_nonnegative',
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      'ingest_source_processings_counts_nonnegative',
      sql`(${table.acceptedCount} IS NULL OR ${table.acceptedCount} >= 0)
        AND (${table.duplicateCount} IS NULL OR ${table.duplicateCount} >= 0)
        AND (${table.rejectedCount} IS NULL OR ${table.rejectedCount} >= 0)`,
    ),
    check(
      'ingest_source_processings_state_consistent',
      sql`(
        ${table.status} = 'succeeded'
        AND ${table.acceptedCount} IS NOT NULL
        AND ${table.duplicateCount} IS NOT NULL
        AND ${table.rejectedCount} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorDetails} IS NULL
      ) OR (
        ${table.status} = 'failed'
        AND ${table.acceptedCount} IS NULL
        AND ${table.duplicateCount} IS NULL
        AND ${table.rejectedCount} IS NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.errorCode} IN ('invalid_json', 'root_not_array', 'database_error')
      ) OR (
        ${table.status} = 'pending'
        AND ${table.acceptedCount} IS NULL
        AND ${table.duplicateCount} IS NULL
        AND ${table.rejectedCount} IS NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorDetails} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.startedAt} IS NULL
      ) OR (
        ${table.status} = 'running'
        AND ${table.acceptedCount} IS NULL
        AND ${table.duplicateCount} IS NULL
        AND ${table.rejectedCount} IS NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorDetails} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.startedAt} IS NOT NULL
      )`,
    ),
  ],
);

export const usageEvents = app.table(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceProcessingId: uuid('source_processing_id')
      .notNull()
      .references(() => ingestSourceProcessings.id, { onDelete: 'restrict' }),
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

export const rejectionReasons = [
  'invalid_record',
  'missing_customer_id',
  'invalid_customer_id',
  'missing_event_type',
  'invalid_event_type',
  'missing_occurred_at',
  'ambiguous_occurred_at',
  'invalid_occurred_at',
  'invalid_endpoint',
  'invalid_user_email',
  'invalid_plan',
  'invalid_metadata',
  'invalid_duration_ms',
  'invalid_status',
] as const;

export const ingestRejections = app.table(
  'ingest_rejections',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sourceProcessingId: uuid('source_processing_id')
      .notNull()
      .references(() => ingestSourceProcessings.id, { onDelete: 'restrict' }),
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
