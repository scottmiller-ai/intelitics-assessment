/**
 * What `/customers/cust_006/usage` answers with nothing else asked for: the
 * billable metric and the window it covers. Fixed size no matter how large the
 * product's vocabulary of endpoints and event types grows.
 */
export const goldenSummary = {
  customer_id: 'cust_006',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { event_count: 3, total_duration_ms: 6458 },
};

/**
 * The same window with every dimension requested, which is the widest this
 * response can get. Each bucket list sums back to the totals above.
 */
export const goldenSummaryBreakdowns = {
  ...goldenSummary,
  breakdowns: {
    event_type: [
      {
        event_type: 'report_generated',
        event_count: 1,
        total_duration_ms: 3496,
      },
      { event_type: 'export', event_count: 1, total_duration_ms: 2769 },
      { event_type: 'login', event_count: 1, total_duration_ms: 193 },
    ],
    status: [
      { status: 'success', event_count: 2, total_duration_ms: 2962 },
      { status: 'timeout', event_count: 1, total_duration_ms: 3496 },
    ],
    plan: [{ plan: 'free', event_count: 3, total_duration_ms: 6458 }],
    endpoint: [
      {
        endpoint: '/v1/reports/generate',
        event_count: 2,
        total_duration_ms: 6265,
      },
      { endpoint: '/v1/users/invite', event_count: 1, total_duration_ms: 193 },
    ],
  },
};

/**
 * cust_006 has three events in July: a 3496 ms `report_generated` that timed
 * out and a 2769 ms `export`, both on `/v1/reports/generate`, plus a 193 ms
 * `login` on `/v1/users/invite`. Every number below is derivable from that by
 * hand, which is the point of a golden.
 */
export const goldenEndpoints = {
  customer_id: 'cust_006',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  endpoints: [
    {
      endpoint: '/v1/reports/generate',
      event_count: 2,
      total_duration_ms: 6265,
      timed_event_count: 2,
      // round(6265 / 2) = round(3132.5), half away from zero.
      avg_duration_ms: 3133,
      max_duration_ms: 3496,
      by_status: [
        { status: 'timeout', event_count: 1, total_duration_ms: 3496 },
        { status: 'success', event_count: 1, total_duration_ms: 2769 },
      ],
    },
    {
      endpoint: '/v1/users/invite',
      event_count: 1,
      total_duration_ms: 193,
      timed_event_count: 1,
      avg_duration_ms: 193,
      max_duration_ms: 193,
      by_status: [
        { status: 'success', event_count: 1, total_duration_ms: 193 },
      ],
    },
  ],
};

export const goldenUsers = {
  customer_id: 'cust_006',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  users: [
    {
      user_email: 'sara@pinebridge.co',
      event_count: 1,
      total_duration_ms: 3496,
    },
    {
      user_email: 'mike@pinebridge.co',
      event_count: 1,
      total_duration_ms: 2769,
    },
    {
      user_email: 'carlos@pinebridge.co',
      event_count: 1,
      total_duration_ms: 193,
    },
  ],
};

export const goldenTopCustomers = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  limit: 10,
  customers: [
    { customer_id: 'cust_004', event_count: 97, total_duration_ms: 194379 },
    { customer_id: 'cust_001', event_count: 85, total_duration_ms: 182382 },
    { customer_id: 'cust_008', event_count: 72, total_duration_ms: 153060 },
    { customer_id: 'cust_012', event_count: 59, total_duration_ms: 115188 },
    { customer_id: 'cust_007', event_count: 34, total_duration_ms: 59861 },
    { customer_id: 'cust_005', event_count: 21, total_duration_ms: 32495 },
    { customer_id: 'cust_010', event_count: 18, total_duration_ms: 35345 },
    { customer_id: 'cust_002', event_count: 13, total_duration_ms: 34058 },
    { customer_id: 'cust_009', event_count: 6, total_duration_ms: 4585 },
    { customer_id: 'cust_003', event_count: 5, total_duration_ms: 8581 },
  ],
};
