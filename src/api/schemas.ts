/**
 * One schema per route part. Fastify compiles these into request validation,
 * response serialization, and the OpenAPI document, so this file is the only
 * place the HTTP contract is stated.
 */

/**
 * Structural ranges only: real month, plausible day, real clock, explicit zone.
 * Month length (February 30th) needs the year, so it is checked in code.
 */
const zonedDateTime = {
  type: 'string',
  pattern:
    '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])' +
    '[Tt](?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?' +
    '(?:[Zz]|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$',
} as const;

export const usageWindowQuery = {
  type: 'object',
  additionalProperties: false,
  // Draft-07 spelling. Fastify's Ajv rejects `dependentRequired`.
  dependencies: { from: ['to'], to: ['from'] },
  properties: {
    from: {
      ...zonedDateTime,
      description:
        'Inclusive start bound. Requires an explicit timezone. Send with `to`, or omit both for the last 30 days.',
      examples: ['2026-07-01T00:00:00Z'],
    },
    to: {
      ...zonedDateTime,
      description:
        'Exclusive end bound. Requires an explicit timezone. Send with `from`, or omit both for the last 30 days. Must be after `from` and no more than 366 days later.',
      examples: ['2026-08-01T00:00:00Z'],
    },
  },
} as const;

export const topCustomersQuery = {
  ...usageWindowQuery,
  properties: {
    ...usageWindowQuery.properties,
    limit: {
      type: 'string',
      pattern: '^(?:[1-9]|[1-9][0-9]|100)$',
      description: 'Base-10 integer from 1 through 100. Defaults to 10.',
      examples: ['10'],
    },
  },
} as const;

export const customerParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      description: 'Producer customer id.',
      examples: ['cust_006'],
    },
  },
} as const;

/**
 * Adapter headers are documented but never `required`. A missing tenant
 * identity is an authentication failure (401), not a schema failure (400).
 */
export const tenantHeaders = {
  type: 'object',
  additionalProperties: true,
  properties: {
    'x-customer-id': {
      type: 'string',
      description:
        'Local stand-in for a verified tenant claim. Must equal `:id`. Not production authentication.',
      examples: ['cust_006'],
    },
  },
} as const;

export const adminHeaders = {
  type: 'object',
  additionalProperties: true,
  properties: {
    'x-admin': {
      type: 'string',
      description:
        'Local stand-in for a cross-tenant billing grant. Must be exactly `true`. Not production authentication.',
      examples: ['true'],
    },
  },
} as const;

const metric = {
  type: 'object',
  additionalProperties: false,
  required: ['event_count', 'total_duration_ms'],
  properties: {
    event_count: { type: 'integer', examples: [3] },
    total_duration_ms: { type: 'integer', examples: [6458] },
  },
} as const;

function bucket(dimension: string, example: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [dimension, 'event_count', 'total_duration_ms'],
    properties: {
      [dimension]: {
        type: ['string', 'null'],
        description: 'Null when the source event did not carry this dimension.',
        examples: [example],
      },
      ...metric.properties,
    },
  };
}

const windowEnvelope = {
  from: {
    type: 'string',
    description: 'Echoed inclusive bound, UTC ISO.',
    examples: ['2026-07-01T00:00:00.000Z'],
  },
  to: {
    type: 'string',
    description: 'Echoed exclusive bound, UTC ISO.',
    examples: ['2026-08-01T00:00:00.000Z'],
  },
} as const;

const customerId = {
  type: 'string',
  examples: ['cust_006'],
} as const;

export const customerSummaryResponse = {
  description: 'Totals plus every non-empty bucket in the window.',
  type: 'object',
  additionalProperties: false,
  required: [
    'customer_id',
    'from',
    'to',
    'totals',
    'by_event_type',
    'by_status',
    'by_plan',
  ],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    totals: metric,
    by_event_type: {
      type: 'array',
      items: bucket('event_type', 'report_generated'),
    },
    by_status: { type: 'array', items: bucket('status', 'success') },
    by_plan: {
      type: 'array',
      items: bucket('plan', 'free'),
      description:
        'Event-time plan snapshots, not authoritative subscriptions.',
    },
  },
} as const;

export const customerEndpointsResponse = {
  description: 'Usage grouped by endpoint.',
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'from', 'to', 'endpoints'],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    endpoints: {
      type: 'array',
      items: bucket('endpoint', '/v1/reports/generate'),
    },
  },
} as const;

export const customerUsersResponse = {
  description: 'Usage grouped by user email.',
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'from', 'to', 'users'],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    users: {
      type: 'array',
      items: bucket('user_email', 'analyst@acme.example'),
    },
  },
} as const;

export const topCustomersResponse = {
  description: 'Customers ranked by event count, then duration, then id.',
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'limit', 'customers'],
  properties: {
    ...windowEnvelope,
    limit: { type: 'integer', examples: [10] },
    customers: { type: 'array', items: bucket('customer_id', 'cust_004') },
  },
} as const;

export const healthResponse = {
  description: 'Serving-pool reachability.',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'database'],
  properties: {
    status: { type: 'string', examples: ['ok'] },
    database: { type: 'string', examples: ['ready'] },
  },
} as const;

function errorResponse(description: string) {
  return {
    description,
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'string',
        description: 'Stable machine-readable code.',
        examples: ['invalid_request'],
      },
      details: {
        type: 'string',
        description: 'Safe human-readable context.',
        examples: ['from must be earlier than to'],
      },
    },
  };
}

export const tenantErrorResponses = {
  400: errorResponse('Unknown parameter, one missing bound, or invalid range.'),
  401: errorResponse('No tenant identity was supplied.'),
  403: errorResponse('Identity is not authorized for this customer.'),
  404: errorResponse('No customer row is visible to this tenant.'),
  500: errorResponse('Unexpected failure. Context stays in the logs.'),
} as const;

export const adminErrorResponses = {
  400: tenantErrorResponses[400],
  403: errorResponse('Cross-tenant billing access was not granted.'),
  500: tenantErrorResponses[500],
} as const;

export interface UsageWindowQuery {
  from?: string;
  to?: string;
}

export interface TopCustomersQuery extends UsageWindowQuery {
  limit?: string;
}

export interface CustomerParams {
  id: string;
}

export interface TenantHeaders {
  'x-customer-id'?: string;
}

export interface AdminHeaders {
  'x-admin'?: string;
}
