export const goldenSummary = {
  customer_id: 'cust_006',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  totals: { event_count: 3, total_duration_ms: 6458 },
  by_event_type: [
    { event_type: 'report_generated', event_count: 1, total_duration_ms: 3496 },
    { event_type: 'export', event_count: 1, total_duration_ms: 2769 },
    { event_type: 'login', event_count: 1, total_duration_ms: 193 },
  ],
  by_status: [
    { status: 'success', event_count: 2, total_duration_ms: 2962 },
    { status: 'timeout', event_count: 1, total_duration_ms: 3496 },
  ],
  by_plan: [{ plan: 'free', event_count: 3, total_duration_ms: 6458 }],
};

export const goldenEndpoints = {
  customer_id: 'cust_006',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  endpoints: [
    {
      endpoint: '/v1/reports/generate',
      event_count: 2,
      total_duration_ms: 6265,
    },
    { endpoint: '/v1/users/invite', event_count: 1, total_duration_ms: 193 },
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
