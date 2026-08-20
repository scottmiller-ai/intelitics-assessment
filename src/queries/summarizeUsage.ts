import type { Sql } from 'postgres';

import { safeMetricNumber } from '../api/validation.js';

export type UsageGroup =
  | 'none'
  | 'endpoint'
  | 'user_email'
  | 'event_type'
  | 'status'
  | 'customer_id'
  | 'plan';

export interface Metric {
  event_count: number;
  total_duration_ms: number;
}

export interface GroupedMetric extends Metric {
  value: string | null;
}

export interface SummarizeUsageOptions {
  sql: Sql;
  customerId?: string;
  from: Date;
  to: Date;
  groupBy: UsageGroup;
  orderBy?: 'event_count' | 'total_duration_ms';
  limit?: number;
}

interface MetricRow {
  event_count: bigint | number | string;
  total_duration_ms: bigint | number | string;
}

function metric(row: MetricRow): Metric {
  return {
    event_count: safeMetricNumber(row.event_count),
    total_duration_ms: safeMetricNumber(row.total_duration_ms),
  };
}

export async function summarizeUsage(
  options: SummarizeUsageOptions,
): Promise<Metric | GroupedMetric[]> {
  const { sql, customerId, from, to, groupBy } = options;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const tenant = customerId ? sql`and customer_id = ${customerId}` : sql``;

  if (groupBy === 'none') {
    const [row] = await sql<MetricRow[]>`
      select
        count(*) as event_count,
        coalesce(sum(duration_ms), 0) as total_duration_ms
      from app.usage_events
      where occurred_at >= ${fromIso}
        and occurred_at < ${toIso}
        ${tenant}
    `;
    if (!row) return { event_count: 0, total_duration_ms: 0 };
    return metric(row);
  }

  const dimension = sql(groupBy);
  const primaryOrder =
    options.orderBy === 'total_duration_ms'
      ? sql`total_duration_ms desc, event_count desc`
      : sql`event_count desc, total_duration_ms desc`;
  const limit =
    options.limit === undefined ? sql`` : sql`limit ${options.limit}`;
  const rows = await sql<(MetricRow & { dimension_value: string | null })[]>`
    select
      ${dimension} as dimension_value,
      count(*) as event_count,
      coalesce(sum(duration_ms), 0) as total_duration_ms
    from app.usage_events
    where occurred_at >= ${fromIso}
      and occurred_at < ${toIso}
      ${tenant}
    group by ${dimension}
    order by ${primaryOrder}, ${dimension} asc nulls last
    ${limit}
  `;

  return rows.map((row) => ({ value: row.dimension_value, ...metric(row) }));
}

export function groupedRows<K extends UsageGroup>(
  key: K,
  rows: GroupedMetric[],
): Array<Record<K, string | null> & Metric> {
  return rows.map(
    ({ value, ...rest }) =>
      ({ [key]: value, ...rest }) as Record<K, string | null> & Metric,
  );
}
