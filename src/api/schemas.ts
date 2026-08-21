/**
 * One schema per route part, and every TypeScript type on this page is derived
 * from one of them. Fastify compiles the same objects into request validation,
 * response serialization, and the OpenAPI document, so the wire contract is
 * stated exactly once: adding a field here is the only way to add a field.
 */
import type { FromSchema } from 'json-schema-to-ts';

import { summaryDimensions } from '../queries/usage.js';

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

const dimensionAlternation = summaryDimensions.join('|');

export const summaryQuery = {
  ...usageWindowQuery,
  properties: {
    ...usageWindowQuery.properties,
    breakdown: {
      type: 'string',
      pattern: `^(?:${dimensionAlternation})(?:,(?:${dimensionAlternation}))*$`,
      description:
        'Optional comma-separated dimensions to decompose the totals by: ' +
        `\`${summaryDimensions.join('`, `')}\`. ` +
        'Omit it and the response is totals only. A repeated dimension is answered once, and breakdowns come back in the order above rather than the order asked for.',
      examples: ['endpoint,status'],
    },
  },
} as const;

/**
 * A producer id long enough to be a payload is not a customer. Bounding it here
 * keeps oversized paths out of the principal check and the database.
 */
export const customerParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Producer customer id.',
      examples: ['cust_006'],
    },
  },
} as const;

/**
 * Adapter headers are documented but never `required`. A missing tenant
 * identity is an authentication failure (401), not a schema failure (400).
 * `additionalProperties` stays open because this schema validates every header
 * the client sent, not just ours.
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

/**
 * The two metrics every grouping reports. Deliberately carries no field-level
 * examples: this object is reused by `totals` and by every bucket, and a
 * renderer that composes an example per array item would stamp the grand total
 * onto each bucket and publish a payload whose parts cannot sum to its own
 * whole. Examples belong on the response, where they can be internally
 * consistent, so each response schema below carries a verified one.
 */
const metric = {
  type: 'object',
  additionalProperties: false,
  required: ['event_count', 'total_duration_ms'],
  properties: {
    event_count: { type: 'integer' },
    total_duration_ms: { type: 'integer' },
  },
} as const;

const dimension = {
  type: ['string', 'null'],
  description: 'Null when the source event did not carry this dimension.',
} as const;

/**
 * One bucket schema per dimension. Written out rather than generated so each
 * shape is readable on the page and its TypeScript type can be derived from it.
 */
const eventTypeBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['event_type', 'event_count', 'total_duration_ms'],
  properties: {
    event_type: { ...dimension, examples: ['report_generated'] },
    ...metric.properties,
  },
} as const;

const statusBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'event_count', 'total_duration_ms'],
  properties: {
    status: { ...dimension, examples: ['success'] },
    ...metric.properties,
  },
} as const;

const planBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'event_count', 'total_duration_ms'],
  properties: {
    plan: { ...dimension, examples: ['free'] },
    ...metric.properties,
  },
} as const;

const endpointBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint', 'event_count', 'total_duration_ms'],
  properties: {
    endpoint: { ...dimension, examples: ['/v1/reports/generate'] },
    ...metric.properties,
  },
} as const;

const userEmailBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['user_email', 'event_count', 'total_duration_ms'],
  properties: {
    user_email: { ...dimension, examples: ['analyst@acme.example'] },
    ...metric.properties,
  },
} as const;

const customerBucket = {
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'event_count', 'total_duration_ms'],
  properties: {
    customer_id: { ...dimension, examples: ['cust_004'] },
    ...metric.properties,
  },
} as const;

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

/**
 * The named drilldown. It reports latency shape and the status split inside one
 * endpoint, which is what makes it a detail view rather than the summary
 * grouped a fifth way.
 */
const endpointDetail = {
  type: 'object',
  additionalProperties: false,
  required: [
    'endpoint',
    'event_count',
    'total_duration_ms',
    'timed_event_count',
    'avg_duration_ms',
    'max_duration_ms',
    'by_status',
  ],
  properties: {
    endpoint: { ...dimension, examples: ['/v1/reports/export'] },
    ...metric.properties,
    timed_event_count: {
      type: 'integer',
      description:
        'Events here that reported a duration. `avg` and `max` cover only these, so `avg * event_count` is not the total.',
      examples: [17],
    },
    avg_duration_ms: {
      type: ['integer', 'null'],
      description:
        'Mean over timed events, whole milliseconds. Null when none reported a duration.',
      examples: [2515],
    },
    max_duration_ms: {
      type: ['integer', 'null'],
      description: 'Slowest timed event. Null when none reported a duration.',
      examples: [4980],
    },
    by_status: {
      type: 'array',
      items: statusBucket,
      description:
        'Producer-reported status split within this endpoint. Status is a grouping, not a billing rule.',
    },
  },
} as const;

const customerId = {
  type: 'string',
  examples: ['cust_006'],
} as const;

/**
 * Each bucket keeps a field named for its own dimension rather than a generic
 * `value`, so a bucket read on its own still says what it counts.
 */
const breakdowns = {
  type: 'object',
  additionalProperties: false,
  description:
    'Present only for the dimensions `breakdown` asked for. Every bucket array sums to `totals`.',
  properties: {
    event_type: { type: 'array', items: eventTypeBucket },
    status: { type: 'array', items: statusBucket },
    plan: {
      type: 'array',
      items: planBucket,
      description:
        'Event-time plan snapshots, not authoritative subscriptions. Two buckets means the tier changed inside the window.',
    },
    endpoint: {
      type: 'array',
      items: endpointBucket,
      description:
        'Endpoint totals. `/usage/endpoints` adds latency shape and the status split.',
    },
  },
} as const;

/**
 * The resource is the metric: what this customer used in this window. A
 * decomposition of that metric is not itself the resource, so it is either
 * asked for by name through `breakdown` or it lives at its own route.
 *
 * The default response is therefore a fixed size however many endpoints and
 * event types the product grows, and a caller who wants one number does not pay
 * for a cube it never asked for.
 */
export const customerSummaryResponse = {
  description:
    'Usage totals for the window, plus any decomposition that was requested. ' +
    'The first example is the default body; the second is the same window with `breakdown=status,endpoint`.',
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'from', 'to', 'totals'],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    totals: metric,
    breakdowns,
  },
  // Both are real responses for cust_006 in July. The second is the same three
  // events decomposed two ways, each summing back to the same totals.
  examples: [
    {
      customer_id: 'cust_006',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      totals: { event_count: 3, total_duration_ms: 6458 },
    },
    {
      customer_id: 'cust_006',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      totals: { event_count: 3, total_duration_ms: 6458 },
      breakdowns: {
        status: [
          { status: 'success', event_count: 2, total_duration_ms: 2962 },
          { status: 'timeout', event_count: 1, total_duration_ms: 3496 },
        ],
        endpoint: [
          {
            endpoint: '/v1/reports/generate',
            event_count: 2,
            total_duration_ms: 6265,
          },
          {
            endpoint: '/v1/users/invite',
            event_count: 1,
            total_duration_ms: 193,
          },
        ],
      },
    },
  ],
} as const;

export const customerEndpointsResponse = {
  description: 'Detailed usage per endpoint: latency shape and status split.',
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'from', 'to', 'endpoints'],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    endpoints: { type: 'array', items: endpointDetail },
  },
  examples: [
    {
      customer_id: 'cust_006',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      endpoints: [
        {
          endpoint: '/v1/reports/generate',
          event_count: 2,
          total_duration_ms: 6265,
          timed_event_count: 2,
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
    },
  ],
} as const;

export const customerUsersResponse = {
  description: 'Usage grouped by user email.',
  type: 'object',
  additionalProperties: false,
  required: ['customer_id', 'from', 'to', 'users'],
  properties: {
    customer_id: customerId,
    ...windowEnvelope,
    users: { type: 'array', items: userEmailBucket },
  },
  examples: [
    {
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
    },
  ],
} as const;

export const topCustomersResponse = {
  description: 'Customers ranked by event count, then duration, then id.',
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'limit', 'customers'],
  properties: {
    ...windowEnvelope,
    limit: { type: 'integer', examples: [10] },
    customers: { type: 'array', items: customerBucket },
  },
  examples: [
    {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      limit: 3,
      customers: [
        {
          customer_id: 'cust_004',
          event_count: 97,
          total_duration_ms: 194379,
        },
        {
          customer_id: 'cust_001',
          event_count: 85,
          total_duration_ms: 182382,
        },
        {
          customer_id: 'cust_008',
          event_count: 72,
          total_duration_ms: 153060,
        },
      ],
    },
  ],
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

const errorBody = {
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
} as const;

function errorResponse(description: string) {
  return { ...errorBody, description };
}

export const tenantErrorResponses = {
  400: errorResponse('Unknown parameter, one missing bound, or invalid range.'),
  401: errorResponse('No tenant identity was supplied.'),
  403: errorResponse('Identity is not authorized for this customer.'),
  404: errorResponse('No usage has been recorded for this customer id.'),
  500: errorResponse('Unexpected failure. Context stays in the logs.'),
} as const;

export const adminErrorResponses = {
  400: tenantErrorResponses[400],
  403: errorResponse('Cross-tenant billing access was not granted.'),
  500: tenantErrorResponses[500],
} as const;

export type UsageWindowQuery = FromSchema<typeof usageWindowQuery>;
export type SummaryQuery = FromSchema<typeof summaryQuery>;
export type TopCustomersQuery = FromSchema<typeof topCustomersQuery>;
export type CustomerParams = FromSchema<typeof customerParams>;
export type TenantHeaders = FromSchema<typeof tenantHeaders>;
export type AdminHeaders = FromSchema<typeof adminHeaders>;
export type CustomerSummary = FromSchema<typeof customerSummaryResponse>;
export type CustomerEndpoints = FromSchema<typeof customerEndpointsResponse>;
export type CustomerUsers = FromSchema<typeof customerUsersResponse>;
export type TopCustomers = FromSchema<typeof topCustomersResponse>;
export type Health = FromSchema<typeof healthResponse>;
