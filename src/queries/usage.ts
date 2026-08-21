import type { ISql } from 'postgres';

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

function toJsonIntegerOrNull(
  value: bigint | number | string | null,
): number | null {
  return value === null ? null : toJsonInteger(value);
}

export interface Metric {
  event_count: number;
  total_duration_ms: number;
}

/**
 * `ISql` is the shared surface of a pool and a transaction, so the same query
 * runs inside a tenant transaction or straight off the admin pool.
 *
 * Bounds stay `Date` and are sent as typed timestamptz parameters rather than
 * strings Postgres has to coerce. Every window is half-open: `>= from`, `< to`.
 */
export interface UsageBounds {
  sql: ISql;
  customerId: string;
  from: Date;
  to: Date;
}

type Aggregate = bigint | number | string;

interface MetricRow {
  event_count: Aggregate;
  total_duration_ms: Aggregate;
}

interface GroupRow extends MetricRow {
  bucket: string | null;
}

/**
 * Grouping-set rows carry a value column and a `g_` flag per requested
 * dimension, so which columns exist depends on the request.
 */
type SummaryRow = MetricRow & Record<string, Aggregate | string | null>;

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

export type Bucket<K extends string> = Record<K, string | null> & Metric;

/**
 * The dimensions a customer's totals can be decomposed by. These are column
 * names, which is why the data layer owns the list: the HTTP schema builds its
 * `breakdown` pattern from this array, so the documented vocabulary and the
 * columns that can reach SQL are the same array.
 *
 * User email is absent on purpose. It is PII with its own retention story, so it
 * is a sub-resource rather than a decomposition.
 */
export const summaryDimensions = [
  'event_type',
  'status',
  'plan',
  'endpoint',
] as const;

export type SummaryDimension = (typeof summaryDimensions)[number];

export interface SummaryBreakdowns {
  event_type?: Bucket<'event_type'>[];
  status?: Bucket<'status'>[];
  plan?: Bucket<'plan'>[];
  endpoint?: Bucket<'endpoint'>[];
}

export interface CustomerUsageSummary {
  totals: Metric;
  breakdowns?: SummaryBreakdowns;
}

/**
 * Totals, and a bucket list for each dimension that was actually asked for.
 *
 * With no dimensions this is a plain two-column aggregate, which is the cheapest
 * statement that answers the billing question and the default a caller gets.
 *
 * With dimensions it is still one pass: `GROUP BY GROUPING SETS` computes the
 * grand total and each requested breakdown together, rather than one rescan per
 * dimension. `grouping(col)` returns 1 when a row aggregated that column away
 * and 0 when the row is grouped by it, which is the only way to tell "this is
 * the grand total, status was not grouped" from "this bucket's status really is
 * null" — a distinction this data contains.
 *
 * Only the requested dimensions are grouped, so a caller wanting one breakdown
 * does not pay to sort the other three.
 */
export async function selectCustomerUsageSummary(
  input: UsageBounds & { dimensions?: readonly SummaryDimension[] },
): Promise<CustomerUsageSummary> {
  const { sql, customerId, from, to } = input;
  // Re-derived from the closed set rather than trusted, so nothing but a known
  // column name can reach the statement below even if a caller skips the schema.
  const dimensions = summaryDimensions.filter((dimension) =>
    input.dimensions?.includes(dimension),
  );

  if (dimensions.length === 0) {
    const [row] = await sql<MetricRow[]>`
      select
        count(*) as event_count,
        coalesce(sum(duration_ms), 0) as total_duration_ms
      from app.usage_events
      where customer_id = ${customerId}
        and occurred_at >= ${from}
        and occurred_at < ${to}
    `;
    return { totals: metric(row) };
  }

  const selected = dimensions
    .map(
      (dimension) => `grouping(${dimension}) as g_${dimension}, ${dimension}`,
    )
    .join(', ');
  const sets = dimensions.map((dimension) => `(${dimension})`).join(', ');
  const tieBreak = `coalesce(${dimensions.join(', ')})`;

  const rows = await sql.unsafe<SummaryRow[]>(
    `select
       ${selected},
       count(*) as event_count,
       coalesce(sum(duration_ms), 0) as total_duration_ms
     from app.usage_events
     where customer_id = $1
       and occurred_at >= $2
       and occurred_at < $3
     group by grouping sets ((), ${sets})
     order by
       event_count desc,
       total_duration_ms desc,
       ${tieBreak} asc nulls last`,
    [customerId, from, to],
  );

  // Asked-for dimensions report even when the window is empty: the key was
  // requested, so an empty list is the answer rather than a missing field.
  const breakdowns: SummaryBreakdowns = {};
  for (const dimension of dimensions) breakdowns[dimension] = [];

  let totals: Metric = { event_count: 0, total_duration_ms: 0 };
  for (const row of rows) {
    // Exactly one dimension is grouped per row, because every grouping set here
    // is a singleton or the empty set.
    const grouped = dimensions.find((dimension) => row[`g_${dimension}`] === 0);
    if (grouped === undefined) {
      totals = metric(row);
      continue;
    }
    breakdowns[grouped]?.push({
      [grouped]: row[grouped] as string | null,
      ...metric(row),
    } as Bucket<SummaryDimension>);
  }
  return { totals, breakdowns };
}

export interface EndpointDetail extends Metric {
  endpoint: string | null;
  timed_event_count: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  by_status: Bucket<'status'>[];
}

interface EndpointDetailRow extends MetricRow {
  endpoint: string | null;
  timed_event_count: Aggregate;
  avg_duration_ms: Aggregate | null;
  max_duration_ms: Aggregate | null;
  status: string | null;
  status_event_count: Aggregate;
  status_total_duration_ms: Aggregate;
}

/**
 * The named drilldown, so it carries more than a regrouped total: latency shape
 * per endpoint plus the status split inside it. Status stays a grouping, never a
 * billing rule, so the split is whatever the producer reported.
 *
 * `avg` and `max` cover only the events that reported a duration, which is why
 * `timed_event_count` ships beside them: without it, `avg * event_count` looks
 * like it should equal the total and does not.
 *
 * The join is `is not distinct from` because a null endpoint is a real bucket
 * here, and `=` would silently drop it.
 */
export async function selectCustomerEndpointDetail(
  input: UsageBounds,
): Promise<EndpointDetail[]> {
  const { sql, customerId, from, to } = input;
  const rows = await sql<EndpointDetailRow[]>`
    with sliced as (
      select endpoint, status, duration_ms
      from app.usage_events
      where customer_id = ${customerId}
        and occurred_at >= ${from}
        and occurred_at < ${to}
    ),
    per_endpoint as (
      select
        endpoint,
        count(*) as event_count,
        coalesce(sum(duration_ms), 0) as total_duration_ms,
        count(duration_ms) as timed_event_count,
        round(avg(duration_ms))::bigint as avg_duration_ms,
        max(duration_ms) as max_duration_ms
      from sliced
      group by endpoint
    ),
    per_status as (
      select
        endpoint,
        status,
        count(*) as event_count,
        coalesce(sum(duration_ms), 0) as total_duration_ms
      from sliced
      group by endpoint, status
    )
    select
      e.endpoint,
      e.event_count,
      e.total_duration_ms,
      e.timed_event_count,
      e.avg_duration_ms,
      e.max_duration_ms,
      s.status,
      s.event_count as status_event_count,
      s.total_duration_ms as status_total_duration_ms
    from per_endpoint e
    join per_status s on s.endpoint is not distinct from e.endpoint
    order by
      e.event_count desc,
      e.total_duration_ms desc,
      e.endpoint asc nulls last,
      s.event_count desc,
      s.total_duration_ms desc,
      s.status asc nulls last
  `;

  // Rows for one endpoint are contiguous: its sort keys are identical across
  // them. A Map keeps first-seen order, which is the order Postgres returned.
  const detail = new Map<string | null, EndpointDetail>();
  for (const row of rows) {
    let entry = detail.get(row.endpoint);
    if (!entry) {
      entry = {
        endpoint: row.endpoint,
        ...metric(row),
        timed_event_count: toJsonInteger(row.timed_event_count),
        avg_duration_ms: toJsonIntegerOrNull(row.avg_duration_ms),
        max_duration_ms: toJsonIntegerOrNull(row.max_duration_ms),
        by_status: [],
      };
      detail.set(row.endpoint, entry);
    }
    entry.by_status.push({
      status: row.status,
      event_count: toJsonInteger(row.status_event_count),
      total_duration_ms: toJsonInteger(row.status_total_duration_ms),
    });
  }
  return [...detail.values()];
}

export async function selectCustomerUsageByUserEmail(
  input: UsageBounds,
): Promise<Bucket<'user_email'>[]> {
  const { sql, customerId, from, to } = input;
  const rows = await sql<GroupRow[]>`
    select
      user_email as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where customer_id = ${customerId}
      and occurred_at >= ${from}
      and occurred_at < ${to}
    group by user_email
    order by
      event_count desc, total_duration_ms desc, user_email asc nulls last
  `;
  return groups('user_email', rows);
}

export async function selectTopCustomers(input: {
  sql: ISql;
  from: Date;
  to: Date;
  limit: number;
}): Promise<Bucket<'customer_id'>[]> {
  const { sql, from, to, limit } = input;
  const rows = await sql<GroupRow[]>`
    select
      customer_id as bucket,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where occurred_at >= ${from}
      and occurred_at < ${to}
    group by customer_id
    order by
      event_count desc, total_duration_ms desc, customer_id asc nulls last
    limit ${limit}
  `;
  return groups('customer_id', rows);
}
