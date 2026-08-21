import type { Sql } from 'postgres';

export class MetricRangeError extends Error {
  constructor(readonly value: bigint | number | string) {
    super('Aggregate cannot be represented as a safe JSON number');
    this.name = 'MetricRangeError';
  }
}

/**
 * Postgres returns `count(*)` and `sum(int)` as bigint. Converting past
 * 2^53 would silently round a billing number, so refuse instead.
 */
export function toJsonInteger(value: bigint | number | string): number {
  const converted = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new MetricRangeError(value);
  }
  return converted;
}

export interface Metric {
  event_count: number;
  total_duration_ms: number;
}

export interface UsageBounds {
  sql: Sql;
  customerId: string;
  from: Date;
  to: Date;
}

interface MetricRow {
  event_count: bigint | number | string;
  total_duration_ms: bigint | number | string;
}

interface GroupRow extends MetricRow {
  bucket: string | null;
}

function bounds(from: Date, to: Date): { fromIso: string; toIso: string } {
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function metric(row: MetricRow | undefined): Metric {
  if (!row) return { event_count: 0, total_duration_ms: 0 };
  return {
    event_count: toJsonInteger(row.event_count),
    total_duration_ms: toJsonInteger(row.total_duration_ms),
  };
}

function groups<K extends string>(
  key: K,
  rows: GroupRow[],
): Array<Record<K, string | null> & Metric> {
  return rows.map((row) => ({
    [key]: row.bucket,
    ...metric(row),
  })) as Array<Record<K, string | null> & Metric>;
}

export async function selectCustomerTotals(
  input: UsageBounds,
): Promise<Metric> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const [row] = await sql<MetricRow[]>`
    select
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
  `;
  return metric(row);
}

export async function selectCustomerUsageByEventType(
  input: UsageBounds,
): Promise<Array<{ event_type: string | null } & Metric>> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      event_type as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by event_type
    order by event_count desc, total_duration_ms desc, event_type asc nulls last
  `;
  return groups('event_type', rows);
}

export async function selectCustomerUsageByStatus(
  input: UsageBounds,
): Promise<Array<{ status: string | null } & Metric>> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      status as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by status
    order by event_count desc, total_duration_ms desc, status asc nulls last
  `;
  return groups('status', rows);
}

export async function selectCustomerUsageByPlan(
  input: UsageBounds,
): Promise<Array<{ plan: string | null } & Metric>> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      plan as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by plan
    order by event_count desc, total_duration_ms desc, plan asc nulls last
  `;
  return groups('plan', rows);
}

export async function selectCustomerUsageByEndpoint(
  input: UsageBounds,
): Promise<Array<{ endpoint: string | null } & Metric>> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      endpoint as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by endpoint
    order by event_count desc, total_duration_ms desc, endpoint asc nulls last
  `;
  return groups('endpoint', rows);
}

export async function selectCustomerUsageByUserEmail(
  input: UsageBounds,
): Promise<Array<{ user_email: string | null } & Metric>> {
  const { sql, customerId, from, to } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      user_email as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by user_email
    order by
      event_count desc, total_duration_ms desc, user_email asc nulls last
  `;
  return groups('user_email', rows);
}

export async function selectTopCustomers(input: {
  sql: Sql;
  from: Date;
  to: Date;
  limit: number;
}): Promise<Array<{ customer_id: string | null } & Metric>> {
  const { sql, from, to, limit } = input;
  const { fromIso, toIso } = bounds(from, to);
  const rows = await sql<GroupRow[]>`
    select
      customer_id as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
    group by customer_id
    order by
      event_count desc, total_duration_ms desc, customer_id asc nulls last
    limit ${limit}
  `;
  return groups('customer_id', rows);
}
