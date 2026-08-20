import { createHash } from 'node:crypto';

import { z } from 'zod';

import { rejectionReasons } from '../db/schema.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RejectionReason = (typeof rejectionReasons)[number];

export interface NormalizedFact {
  customerId: string;
  durationMs: number | null;
  endpoint: string | null;
  eventType: string;
  metadata: Record<string, JsonValue>;
  occurredAt: string;
  plan: string | null;
  status: string | null;
  userEmail: string | null;
}

export type NormalizationResult =
  | { fact: NormalizedFact; ingestHash: string }
  | { reject: true; reason: RejectionReason };

const zonedDateTime = z.iso.datetime({ offset: true });
const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/;
const durationString = /^[0-9]+ms$/;
const maxDuration = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsNullCharacter(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(containsNullCharacter);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) => key.includes('\0') || containsNullCharacter(entry),
  );
}

function requiredString(
  record: Record<string, unknown>,
  field: 'customer_id' | 'event_type',
): { value: string } | { reason: RejectionReason } {
  const value = record[field];
  const missingReason =
    field === 'customer_id' ? 'missing_customer_id' : 'missing_event_type';
  const invalidReason =
    field === 'customer_id' ? 'invalid_customer_id' : 'invalid_event_type';

  if (value === undefined || value === null) return { reason: missingReason };
  if (typeof value !== 'string') return { reason: invalidReason };
  const trimmed = value.trim();
  if (!trimmed) return { reason: missingReason };
  if (trimmed.includes('\0')) return { reason: invalidReason };
  return { value: trimmed };
}

function optionalString(
  value: unknown,
  reason: RejectionReason,
): { value: string | null } | { reason: RejectionReason } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { reason };
  const trimmed = value.trim();
  if (trimmed.includes('\0')) return { reason };
  return trimmed ? { value: trimmed } : { reason };
}

function parseDuration(
  value: unknown,
): { value: number | null } | { reason: 'invalid_duration_ms' } {
  if (value === undefined || value === null) return { value: null };
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maxDuration
  ) {
    return { value };
  }
  if (typeof value === 'string' && durationString.test(value)) {
    const parsed = Number(value.slice(0, -2));
    if (Number.isSafeInteger(parsed) && parsed <= maxDuration)
      return { value: parsed };
  }
  return { reason: 'invalid_duration_ms' };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }
  return serialized;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

export function rejectionHash(input: {
  sourceContentSha256: string;
  sourceIndex: number;
  reason: RejectionReason;
  raw: JsonValue;
}): string {
  return sha256Canonical({
    source_content_sha256: input.sourceContentSha256,
    source_index: input.sourceIndex,
    reason: input.reason,
    raw: input.raw,
  });
}

export function normalizeEvent(raw: unknown): NormalizationResult {
  if (!isRecord(raw)) return { reject: true, reason: 'invalid_record' };

  const customer = requiredString(raw, 'customer_id');
  if ('reason' in customer) return { reject: true, reason: customer.reason };

  const eventType = requiredString(raw, 'event_type');
  if ('reason' in eventType) return { reject: true, reason: eventType.reason };

  const occurredAt = raw.occurred_at;
  if (occurredAt === undefined || occurredAt === null) {
    return { reject: true, reason: 'missing_occurred_at' };
  }
  if (typeof occurredAt !== 'string') {
    return { reject: true, reason: 'invalid_occurred_at' };
  }
  const trimmedOccurredAt = occurredAt.trim();
  if (!explicitZone.test(trimmedOccurredAt)) {
    return { reject: true, reason: 'ambiguous_occurred_at' };
  }
  if (!zonedDateTime.safeParse(trimmedOccurredAt).success) {
    return { reject: true, reason: 'invalid_occurred_at' };
  }

  const endpoint = optionalString(raw.endpoint, 'invalid_endpoint');
  if ('reason' in endpoint) return { reject: true, reason: endpoint.reason };
  const userEmail = optionalString(raw.user_email, 'invalid_user_email');
  if ('reason' in userEmail) return { reject: true, reason: userEmail.reason };
  const plan = optionalString(raw.plan, 'invalid_plan');
  if ('reason' in plan) return { reject: true, reason: plan.reason };

  const metadataValue = raw.metadata;
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    !isRecord(metadataValue)
  ) {
    return { reject: true, reason: 'invalid_metadata' };
  }
  if (containsNullCharacter(metadataValue)) {
    return { reject: true, reason: 'invalid_metadata' };
  }
  const metadata = metadataValue == null ? {} : { ...metadataValue };

  const duration = parseDuration(metadata.duration_ms);
  if ('reason' in duration) return { reject: true, reason: duration.reason };
  const status = optionalString(metadata.status, 'invalid_status');
  if ('reason' in status) return { reject: true, reason: status.reason };
  delete metadata.duration_ms;
  delete metadata.status;

  const fact: NormalizedFact = {
    customerId: customer.value,
    durationMs: duration.value,
    endpoint: endpoint.value,
    eventType: eventType.value,
    metadata: metadata as Record<string, JsonValue>,
    occurredAt: new Date(trimmedOccurredAt).toISOString(),
    plan: plan.value,
    status: status.value,
    userEmail: userEmail.value,
  };

  const hashInput = {
    customer_id: fact.customerId,
    duration_ms: fact.durationMs,
    endpoint: fact.endpoint,
    event_type: fact.eventType,
    metadata: fact.metadata,
    occurred_at: fact.occurredAt,
    plan: fact.plan,
    status: fact.status,
    user_email: fact.userEmail,
  };

  return { fact, ingestHash: sha256Canonical(hashInput) };
}
