import { type SummaryDimension, summaryDimensions } from '../queries/usage.js';
import { badRequest } from './errors.js';
import type { TopCustomersQuery, UsageWindowQuery } from './schemas.js';

const defaultWindowMs = 30 * 24 * 60 * 60 * 1000;
const maxWindowMs = 366 * 24 * 60 * 60 * 1000;
const defaultLimit = 10;

export interface UsageWindow {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
}

function toWindow(from: Date, to: Date): UsageWindow {
  return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * `new Date('2026-02-31T00:00:00Z')` rolls forward to March 3rd rather than
 * failing, which would quietly bill the wrong window. Reject instead.
 */
function parseInstant(value: string, field: 'from' | 'to'): Date {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const instant = new Date(value);
  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    Number.isNaN(instant.getTime())
  ) {
    throw badRequest(`${field} is not a real calendar datetime`);
  }
  return instant;
}

/**
 * The schema already enforced the key set, the zoned-timestamp shape, and that
 * both bounds arrive together. Left here are the rules JSON Schema cannot
 * state: calendar validity, ordering, and the window cap.
 */
export function resolveUsageWindow(
  query: UsageWindowQuery,
  now: Date = new Date(),
): UsageWindow {
  if (query.from === undefined || query.to === undefined) {
    const to = new Date(now);
    return toWindow(new Date(to.getTime() - defaultWindowMs), to);
  }
  const from = parseInstant(query.from, 'from');
  const to = parseInstant(query.to, 'to');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0) {
    throw badRequest('from must be earlier than to');
  }
  if (duration > maxWindowMs) {
    throw badRequest('Usage window cannot exceed 366 days');
  }
  return toWindow(from, to);
}

/**
 * The schema already proved every name is a known dimension, so this only makes
 * the list canonical: repeats collapse, and the order comes from the declared
 * dimensions rather than from the request. One window then has one response
 * whatever order the caller spelled the parameter in, which is what makes the
 * body worth caching later.
 */
export function resolveBreakdown(breakdown?: string): SummaryDimension[] {
  if (breakdown === undefined) return [];
  const requested = new Set(breakdown.split(','));
  return summaryDimensions.filter((dimension) => requested.has(dimension));
}

export function resolveTopCustomersQuery(
  query: TopCustomersQuery,
  now: Date = new Date(),
): UsageWindow & { limit: number } {
  return {
    ...resolveUsageWindow(query, now),
    limit: query.limit === undefined ? defaultLimit : Number(query.limit),
  };
}
