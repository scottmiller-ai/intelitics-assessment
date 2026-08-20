import { z } from 'zod';

const zonedDateTime = z.iso.datetime({ offset: true });
const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/;
const maxWindowMs = 366 * 24 * 60 * 60 * 1000;

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export interface UsageWindow {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
}

function parseDateTime(value: string, field: 'from' | 'to'): Date {
  const trimmed = value.trim();
  if (
    !explicitZone.test(trimmed) ||
    !zonedDateTime.safeParse(trimmed).success
  ) {
    throw new RequestValidationError(
      `${field} must be an explicitly zoned ISO datetime`,
    );
  }
  return new Date(trimmed);
}

export function parseUsageWindow(
  query: Record<string, unknown>,
  now: Date = new Date(),
): UsageWindow {
  const allowed = new Set(['from', 'to']);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unknown query parameter: ${unknown[0]}`);
  }

  const fromValue = query.from;
  const toValue = query.to;
  if (fromValue === undefined && toValue === undefined) {
    const to = new Date(now);
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
  }
  if (typeof fromValue !== 'string' || typeof toValue !== 'string') {
    throw new RequestValidationError('from and to must be supplied together');
  }
  const from = parseDateTime(fromValue, 'from');
  const to = parseDateTime(toValue, 'to');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0) {
    throw new RequestValidationError('from must be earlier than to');
  }
  if (duration > maxWindowMs) {
    throw new RequestValidationError('Usage window cannot exceed 366 days');
  }
  return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
}

export function parseTopCustomersQuery(
  query: Record<string, unknown>,
  now: Date = new Date(),
): UsageWindow & { limit: number } {
  const allowed = new Set(['from', 'to', 'limit']);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unknown query parameter: ${unknown[0]}`);
  }
  const { limit: rawLimit, ...windowQuery } = query;
  let limit = 10;
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'string' ||
      !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)
    ) {
      throw new RequestValidationError(
        'limit must be an integer from 1 through 100',
      );
    }
    limit = Number(rawLimit);
  }
  return { ...parseUsageWindow(windowQuery, now), limit };
}

export function requireTenantIdentity(
  header: string | string[] | undefined,
  customerId: string,
): void {
  if (header === undefined) {
    throw Object.assign(new Error('X-Customer-Id is required'), {
      statusCode: 401,
      code: 'customer_identity_required',
    });
  }
  if (Array.isArray(header) && header.length !== 1) {
    throw new RequestValidationError('X-Customer-Id must be supplied once');
  }
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== customerId) {
    throw Object.assign(
      new Error('X-Customer-Id must match the requested customer'),
      {
        statusCode: 403,
        code: 'tenant_mismatch',
      },
    );
  }
}

export function requireAdmin(header: string | string[] | undefined): void {
  if (Array.isArray(header) && header.length !== 1) {
    throw new RequestValidationError('X-Admin must be supplied once');
  }
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== 'true') {
    throw Object.assign(new Error('X-Admin: true is required'), {
      statusCode: 403,
      code: 'admin_required',
    });
  }
}

export function safeMetricNumber(value: bigint | number | string): number {
  const converted = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw Object.assign(
      new Error('Aggregate cannot be represented as a safe JSON number'),
      {
        statusCode: 500,
        code: 'aggregate_out_of_range',
      },
    );
  }
  return converted;
}
