import { eq, sql as drizzleSql } from 'drizzle-orm';

import { createIngestClient, type DatabaseClient } from '../db/client.js';
import {
  customers,
  ingestRejections,
  ingestSourceProcessings,
  ingestSources,
  usageEvents,
} from '../db/schema.js';
import type { HashedSource } from './hashSource.js';
import {
  normalizeEvent,
  rejectionHash,
  type JsonValue,
  type RejectionReason,
} from './normalizeEvent.js';

export const NORMALIZATION_POLICY_VERSION = 1;

export interface IngestSucceeded {
  status: 'succeeded';
  source_id: string;
  processing_id: string;
  normalization_policy_version: number;
  source_duplicate: false;
  forced: boolean;
  accepted: number;
  duplicate: number;
  rejected: number;
  rejected_by_reason: Partial<Record<RejectionReason, number>>;
}

export interface IngestSkipped {
  status: 'skipped';
  source_id: string;
  processing_id: string;
  normalization_policy_version: number;
  source_duplicate: true;
  processed: 0;
}

export type IngestSummary = IngestSucceeded | IngestSkipped;
export type SourceFailureCode =
  'invalid_json' | 'root_not_array' | 'database_error';

export class IngestFailure extends Error {
  constructor(
    readonly code: SourceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'IngestFailure';
  }
}

function safeDetails(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Unknown database failure';
  const printable = [...message]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  return printable
    .replaceAll(/postgres:\/\/[^@\s]+@/g, 'postgres://***@')
    .slice(0, 500);
}

async function markFailed(
  connection: Awaited<ReturnType<DatabaseClient['sql']['reserve']>>,
  processingId: string,
  code: SourceFailureCode,
  details: string,
): Promise<void> {
  await connection`
    update app.ingest_source_processings
    set status = 'failed',
        accepted_count = null,
        duplicate_count = null,
        rejected_count = null,
        error_code = ${code},
        error_details = ${details},
        completed_at = now()
    where id = ${processingId}::uuid
  `;
}

export async function ingestHashedSource(
  source: HashedSource,
  options: {
    force?: boolean;
    normalizationPolicyVersion?: number;
    client?: DatabaseClient;
  } = {},
): Promise<IngestSummary> {
  const policyVersion =
    options.normalizationPolicyVersion ?? NORMALIZATION_POLICY_VERSION;
  const client = options.client ?? createIngestClient();
  const ownsClient = options.client === undefined;

  try {
    await client.db
      .insert(ingestSources)
      .values({
        contentSha256: source.contentSha256,
        sourceUri: source.sourceUri,
        byteSize: source.byteSize,
      })
      .onConflictDoNothing({ target: ingestSources.contentSha256 });
    const [sourceRow] = await client.db
      .select({ id: ingestSources.id })
      .from(ingestSources)
      .where(eq(ingestSources.contentSha256, source.contentSha256));
    if (!sourceRow)
      throw new IngestFailure('database_error', 'Source upsert failed');

    const connection = await client.sql.reserve();
    const lockKey = `${sourceRow.id}:${policyVersion}`;
    let locked = false;

    try {
      await connection`
        select pg_advisory_lock(hashtextextended(${lockKey}, 0))
      `;
      locked = true;

      await connection`
        insert into app.ingest_source_processings
          (source_id, normalization_policy_version, status)
        values (${sourceRow.id}::uuid, ${policyVersion}, 'pending')
        on conflict (source_id, normalization_policy_version) do nothing
      `;
      const [processing] = await connection<{ id: string; status: string }[]>`
        select id, status
        from app.ingest_source_processings
        where source_id = ${sourceRow.id}::uuid
          and normalization_policy_version = ${policyVersion}
      `;
      if (!processing)
        throw new IngestFailure('database_error', 'Processing upsert failed');
      if (processing.status === 'succeeded' && !options.force) {
        return {
          status: 'skipped',
          source_id: sourceRow.id,
          processing_id: processing.id,
          normalization_policy_version: policyVersion,
          source_duplicate: true,
          processed: 0,
        };
      }

      await connection`
        update app.ingest_source_processings
        set status = 'running',
            attempt_count = attempt_count + 1,
            last_forced = ${options.force ?? false},
            started_at = now(),
            completed_at = null,
            accepted_count = null,
            duplicate_count = null,
            rejected_count = null,
            error_code = null,
            error_details = null
        where id = ${processing.id}::uuid
      `;

      let rows: unknown;
      try {
        rows = JSON.parse(source.bytes.toString('utf8')) as unknown;
      } catch (error) {
        const details = safeDetails(error);
        await markFailed(connection, processing.id, 'invalid_json', details);
        throw new IngestFailure('invalid_json', details);
      }
      if (!Array.isArray(rows)) {
        const details = 'Source JSON root must be an array';
        await markFailed(connection, processing.id, 'root_not_array', details);
        throw new IngestFailure('root_not_array', details);
      }

      const rejectedByReason: Partial<Record<RejectionReason, number>> = {};
      let accepted = 0;
      let duplicate = 0;
      let rejected = 0;

      try {
        await client.db.transaction(async (db) => {
          for (const [sourceIndex, raw] of rows.entries()) {
            const result = normalizeEvent(raw);
            if ('reject' in result) {
              rejected += 1;
              rejectedByReason[result.reason] =
                (rejectedByReason[result.reason] ?? 0) + 1;
              await db
                .insert(ingestRejections)
                .values({
                  sourceProcessingId: processing.id,
                  sourceIndex,
                  raw:
                    raw === null
                      ? drizzleSql`'null'::jsonb`
                      : (raw as JsonValue),
                  reason: result.reason,
                  rejectionHash: rejectionHash({
                    sourceContentSha256: source.contentSha256,
                    normalizationPolicyVersion: policyVersion,
                    sourceIndex,
                    reason: result.reason,
                    raw: raw as JsonValue,
                  }),
                })
                .onConflictDoNothing({
                  target: ingestRejections.rejectionHash,
                });
              continue;
            }

            await db
              .insert(customers)
              .values({ id: result.fact.customerId })
              .onConflictDoNothing({ target: customers.id });
            const inserted = await db
              .insert(usageEvents)
              .values({
                sourceProcessingId: processing.id,
                sourceIndex,
                customerId: result.fact.customerId,
                eventType: result.fact.eventType,
                endpoint: result.fact.endpoint,
                userEmail: result.fact.userEmail,
                plan: result.fact.plan,
                occurredAt: new Date(result.fact.occurredAt),
                durationMs: result.fact.durationMs,
                status: result.fact.status,
                metadata: result.fact.metadata,
                ingestHash: result.ingestHash,
              })
              .onConflictDoNothing({ target: usageEvents.ingestHash })
              .returning({ id: usageEvents.id });
            if (inserted.length === 0) duplicate += 1;
            else accepted += 1;
          }

          await db
            .update(ingestSourceProcessings)
            .set({
              status: 'succeeded',
              acceptedCount: accepted,
              duplicateCount: duplicate,
              rejectedCount: rejected,
              completedAt: new Date(),
              errorCode: null,
              errorDetails: null,
            })
            .where(eq(ingestSourceProcessings.id, processing.id));
        });
      } catch (error) {
        const details = safeDetails(error);
        await markFailed(connection, processing.id, 'database_error', details);
        throw new IngestFailure('database_error', details);
      }

      return {
        status: 'succeeded',
        source_id: sourceRow.id,
        processing_id: processing.id,
        normalization_policy_version: policyVersion,
        source_duplicate: false,
        forced: options.force ?? false,
        accepted,
        duplicate,
        rejected,
        rejected_by_reason: rejectedByReason,
      };
    } finally {
      if (locked) {
        await connection`
          select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
        `;
      }
      connection.release();
    }
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    throw new IngestFailure('database_error', safeDetails(error));
  } finally {
    if (ownsClient) await client.close();
  }
}
