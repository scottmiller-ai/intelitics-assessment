import { createIngestClient, type DatabaseClient } from '../db/client.js';
import type { HashedSource } from './hashSource.js';
import {
  normalizeEvent,
  rejectionHash,
  type JsonValue,
  type RejectionReason,
} from './normalizeEvent.js';

export interface IngestSucceeded {
  status: 'succeeded';
  source_id: string;
  source_duplicate: false;
  accepted: number;
  duplicate: number;
  rejected: number;
  rejected_by_reason: Partial<Record<RejectionReason, number>>;
}

export interface IngestSkipped {
  status: 'skipped';
  source_id: string;
  source_duplicate: true;
  processed: 0;
}

export type IngestSummary = IngestSucceeded | IngestSkipped;
export type SourceFailureCode =
  'invalid_utf8' | 'invalid_json' | 'root_not_array' | 'database_error';

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

/**
 * Postgres `jsonb` cannot hold a NUL, so the rejected payload we keep for
 * forensics is not byte-exact. U+FFFD is the substitution: it is what "a
 * character was here that this column cannot represent" already means, where an
 * escape like `\u0000` would read as ordinary data the producer had sent. Byte
 * exact storage needs a `bytea` column, which is a later decision.
 */
const unrepresentable = '\uFFFD';

function postgresSafeJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return value.replaceAll('\0', unrepresentable);
  if (Array.isArray(value)) return value.map(postgresSafeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replaceAll('\0', unrepresentable),
      postgresSafeJson(entry),
    ]),
  );
}

function parseRows(source: HashedSource): unknown[] {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
  } catch (error) {
    throw new IngestFailure('invalid_utf8', safeDetails(error));
  }

  let rows: unknown;
  try {
    rows = JSON.parse(decoded) as unknown;
  } catch (error) {
    throw new IngestFailure('invalid_json', safeDetails(error));
  }
  if (!Array.isArray(rows)) {
    throw new IngestFailure(
      'root_not_array',
      'Source JSON root must be an array',
    );
  }
  return rows;
}

export async function ingestHashedSource(
  source: HashedSource,
  options: { client?: DatabaseClient } = {},
): Promise<IngestSummary> {
  const rows = parseRows(source);
  const normalized = rows.map((raw) => normalizeEvent(raw));
  const client = options.client ?? createIngestClient();
  const ownsClient = options.client === undefined;

  try {
    const connection = await client.sql.reserve();
    try {
      const rejectedByReason: Partial<Record<RejectionReason, number>> = {};
      let accepted = 0;
      let duplicate = 0;
      let rejected = 0;

      let transactionOpen = false;
      try {
        await connection.unsafe('begin');
        transactionOpen = true;
        await connection`
          select pg_advisory_xact_lock(
            hashtextextended(${source.contentSha256}, 0)
          )
        `;
        const [sourceRow] = await connection<{ id: string }[]>`
          insert into app.ingest_sources
            (content_sha256, source_uri, byte_size)
          values (
            ${source.contentSha256},
            ${source.sourceUri},
            ${source.byteSize}
          )
          on conflict (content_sha256) do nothing
          returning id
        `;
        if (!sourceRow) {
          const [existing] = await connection<{ id: string }[]>`
            select id
            from app.ingest_sources
            where content_sha256 = ${source.contentSha256}
          `;
          if (!existing) {
            throw new Error('Source conflict could not be resolved');
          }
          await connection.unsafe('commit');
          transactionOpen = false;
          return {
            status: 'skipped',
            source_id: existing.id,
            source_duplicate: true,
            processed: 0,
          };
        }

        for (const [sourceIndex, raw] of rows.entries()) {
          const result = normalized[sourceIndex]!;
          if ('reject' in result) {
            rejected += 1;
            rejectedByReason[result.reason] =
              (rejectedByReason[result.reason] ?? 0) + 1;
            const persistedRaw = postgresSafeJson(raw as JsonValue);
            const hash = rejectionHash({
              sourceContentSha256: source.contentSha256,
              sourceIndex,
              reason: result.reason,
              raw: persistedRaw,
            });
            await connection`
              insert into app.ingest_rejections
                (source_id, source_index, raw, reason, rejection_hash)
              values (
                ${sourceRow.id}::uuid,
                ${sourceIndex},
                ${JSON.stringify(persistedRaw)}::jsonb,
                ${result.reason},
                ${hash}
              )
              on conflict (rejection_hash) do nothing
            `;
            continue;
          }

          await connection`
            insert into app.customers (id)
            values (${result.fact.customerId})
            on conflict (id) do nothing
          `;
          const [inserted] = await connection<{ id: string }[]>`
            insert into app.usage_events (
              source_id,
              source_index,
              customer_id,
              event_type,
              endpoint,
              user_email,
              plan,
              occurred_at,
              duration_ms,
              status,
              metadata,
              ingest_hash
            )
            values (
              ${sourceRow.id}::uuid,
              ${sourceIndex},
              ${result.fact.customerId},
              ${result.fact.eventType},
              ${result.fact.endpoint},
              ${result.fact.userEmail},
              ${result.fact.plan},
              ${result.fact.occurredAt}::timestamptz,
              ${result.fact.durationMs},
              ${result.fact.status},
              ${JSON.stringify(result.fact.metadata)}::jsonb,
              ${result.ingestHash}
            )
            on conflict (ingest_hash) do nothing
            returning id
          `;
          if (!inserted) duplicate += 1;
          else accepted += 1;
        }
        await connection.unsafe('commit');
        transactionOpen = false;
        return {
          status: 'succeeded',
          source_id: sourceRow.id,
          source_duplicate: false,
          accepted,
          duplicate,
          rejected,
          rejected_by_reason: rejectedByReason,
        };
      } catch (error) {
        if (transactionOpen) {
          try {
            await connection.unsafe('rollback');
          } catch {
            // The original database failure is more actionable.
          }
        }
        const details = safeDetails(error);
        throw new IngestFailure('database_error', details);
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    throw new IngestFailure('database_error', safeDetails(error));
  } finally {
    if (ownsClient) await client.close();
  }
}
