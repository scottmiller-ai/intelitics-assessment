import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminPrincipal,
  authorizeCustomer,
  tenantPrincipal,
} from '../api/principal.js';
import {
  customerEndpointsResponse,
  customerSummaryResponse,
  customerUsersResponse,
  healthResponse,
  tenantErrorResponses,
  topCustomersResponse,
} from '../api/schemas.js';
import { buildServer } from '../api/server.js';
import {
  resolveBreakdown,
  resolveTopCustomersQuery,
  resolveUsageWindow,
} from '../api/usageWindow.js';
import type { DatabaseClient } from '../db/client.js';
import { summaryDimensions, toJsonInteger } from '../queries/usage.js';
import {
  goldenEndpoints,
  goldenSummary,
  goldenSummaryBreakdowns,
  goldenTopCustomers,
  goldenUsers,
} from './goldenResponses.js';

const from = '2026-07-01T00:00:00Z';
const to = '2026-08-01T00:00:00+00:00';
const range = `from=${from}&to=${encodeURIComponent(to)}`;

/**
 * Rejections declared in the route schema are enforced before any handler runs,
 * so these need a server but never a database.
 */
function unusedClient(): DatabaseClient {
  const unreachable = () => {
    throw new Error('The database must not be reached');
  };
  return {
    sql: unreachable as unknown as Sql,
    close: () => Promise.resolve(),
  };
}

describe('request contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      tenant: unusedClient(),
      billingAdmin: unusedClient(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['unknown query parameter', `/customers/cust_001/usage?${range}&extra=x`],
    ['one missing bound', `/customers/cust_001/usage?from=${from}`],
    [
      'naive timestamp',
      '/customers/cust_001/usage?from=2026-07-01T00:00:00&to=2026-08-01T00:00:00',
    ],
    [
      'whitespace-padded bound',
      `/customers/cust_001/usage?from=%20${from}&to=${from}`,
    ],
    [
      'inverted range',
      `/customers/cust_001/usage?from=${from}&to=2026-06-01T00:00:00Z`,
    ],
    ['equal bounds', `/customers/cust_001/usage?from=${from}&to=${from}`],
    [
      'window over 366 days',
      '/customers/cust_001/usage?from=2025-01-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    ],
    [
      'impossible calendar date',
      '/customers/cust_001/usage?from=2026-02-31T00:00:00Z&to=2026-08-01T00:00:00Z',
    ],
    [
      'month out of range',
      '/customers/cust_001/usage?from=2026-13-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    ],
    [
      'hour out of range',
      '/customers/cust_001/usage?from=2026-07-01T25:00:00Z&to=2026-08-01T00:00:00Z',
    ],
  ])('rejects %s with 400 invalid_request', async (_label, url) => {
    const response = await app.inject({
      url,
      headers: { 'x-customer-id': 'cust_001' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it.each(['0', '01', '101', '1.5', '-1', 'abc'])(
    'rejects limit %s',
    async (limit) => {
      const response = await app.inject({
        url: `/usage/top-customers?${range}&limit=${limit}`,
        headers: { 'x-admin': 'true' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_request' });
    },
  );

  it('answers missing identity with 401 and a foreign identity with 403', async () => {
    const anonymous = await app.inject({
      url: `/customers/cust_001/usage?${range}`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({
      error: 'customer_identity_required',
    });

    const foreign = await app.inject({
      url: `/customers/cust_001/usage?${range}`,
      headers: { 'x-customer-id': 'cust_002' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: 'tenant_mismatch' });
  });

  // Fastify's default not-found body puts the reason phrase "Not Found" in
  // `error`, which is documented as a stable code. One envelope, always.
  it.each([
    ['an unknown path', 'GET', '/nope?from=x'],
    ['a wrong method on a known path', 'POST', `/customers/cust_001/usage`],
  ])(
    'answers %s with the documented error shape',
    async (_label, method, url) => {
      const response = await app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: { 'x-customer-id': 'cust_001' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'not_found' });
    },
  );

  it('requires the exact admin grant', async () => {
    const response = await app.inject({
      url: `/usage/top-customers?${range}`,
      headers: { 'x-admin': 'True' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'admin_required' });
  });

  /**
   * `details` is a published field, so its wording has to be ours. If these
   * strings only ever came from Ajv, upgrading the validator would reword the
   * API.
   */
  it.each([
    [
      `/customers/cust_001/usage?${range}&extra=x`,
      'Unknown query parameter: extra',
    ],
    [
      `/customers/cust_001/usage?from=${from}`,
      'from and to must be sent together',
    ],
    [
      '/customers/cust_001/usage?from=2026-07-01T00:00:00&to=2026-08-01T00:00:00',
      'Invalid value for query parameter: from',
    ],
    [
      `/customers/${'c'.repeat(65)}/usage?${range}`,
      'Invalid value for path parameter: id',
    ],
  ])('explains %s in our own words', async (url, details) => {
    const response = await app.inject({
      url,
      headers: { 'x-customer-id': 'cust_001' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request', details });
  });

  it('publishes every route in the generated document', async () => {
    const spec = await app.inject({ url: '/docs/json' });
    const document = spec.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(document.paths).sort()).toEqual([
      '/customers/{id}/usage',
      '/customers/{id}/usage/endpoints',
      '/customers/{id}/usage/users',
      '/health',
      '/usage/top-customers',
    ]);
  });
});

describe('usage window resolution', () => {
  it('normalizes explicit bounds to UTC', () => {
    expect(resolveUsageWindow({ from, to })).toMatchObject({
      fromIso: '2026-07-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
  });

  it('captures now once for the default 30-day window', () => {
    expect(
      resolveUsageWindow({}, new Date('2026-08-01T00:00:00Z')),
    ).toMatchObject({
      fromIso: '2026-07-02T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
  });

  it('accepts exactly a 366-day window', () => {
    expect(() =>
      resolveUsageWindow({
        from: '2024-01-01T00:00:00Z',
        to: '2025-01-01T00:00:00Z',
      }),
    ).not.toThrow();
  });

  it('defaults and carries the top-customer limit', () => {
    expect(resolveTopCustomersQuery({ from, to }).limit).toBe(10);
    expect(resolveTopCustomersQuery({ from, to, limit: '100' }).limit).toBe(
      100,
    );
  });
});

describe('breakdown resolution', () => {
  it('asks for nothing when the parameter is absent', () => {
    expect(resolveBreakdown(undefined)).toEqual([]);
  });

  it('answers a repeated dimension once', () => {
    expect(resolveBreakdown('plan,plan,plan')).toEqual(['plan']);
  });

  it('reports in the declared order, not the requested order', () => {
    expect(resolveBreakdown('endpoint,event_type')).toEqual([
      'event_type',
      'endpoint',
    ]);
    expect(
      resolveBreakdown([...summaryDimensions].reverse().join(',')),
    ).toEqual([...summaryDimensions]);
  });
});

describe('principals', () => {
  it('separates missing identity from unauthorized identity', () => {
    expect(() => tenantPrincipal(undefined)).toThrowError(
      expect.objectContaining({
        status: 401,
        code: 'customer_identity_required',
      }),
    );
    expect(() =>
      authorizeCustomer(tenantPrincipal('cust_002'), 'cust_001'),
    ).toThrowError(
      expect.objectContaining({ status: 403, code: 'tenant_mismatch' }),
    );
    expect(() =>
      authorizeCustomer(tenantPrincipal('cust_001'), 'cust_001'),
    ).not.toThrow();
  });

  it('grants admin only on the exact stub value', () => {
    expect(() => adminPrincipal('True')).toThrowError(
      expect.objectContaining({ status: 403, code: 'admin_required' }),
    );
    expect(adminPrincipal('true')).toEqual({ kind: 'admin' });
  });
});

/**
 * Handlers are typed from these schemas, so a body that stops matching the
 * document fails to compile. What the compiler cannot check is whether the
 * schema itself describes the numbers we mean to publish: Fastify serializes
 * responses through it rather than validating against it, so a loose schema
 * quietly reshapes a billing body instead of failing. These assertions are the
 * other half.
 */
describe('published response contracts', () => {
  const ajv = new Ajv({ allErrors: true });

  function assertValid(schema: object, body: unknown): void {
    const validate = ajv.compile(schema);
    expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
  }

  it.each([
    ['customer summary', customerSummaryResponse, goldenSummary],
    [
      'decomposed customer summary',
      customerSummaryResponse,
      goldenSummaryBreakdowns,
    ],
    ['endpoint detail', customerEndpointsResponse, goldenEndpoints],
    ['user detail', customerUsersResponse, goldenUsers],
    ['top customers', topCustomersResponse, goldenTopCustomers],
  ])('accepts the documented %s body', (_label, schema, body) => {
    assertValid(schema, body);
  });

  it('accepts both documented health bodies', () => {
    assertValid(healthResponse, { status: 'ok', database: 'ready' });
    assertValid(healthResponse, {
      status: 'unavailable',
      database: 'unavailable',
    });
  });

  it('accepts an error body and its optional details', () => {
    assertValid(tenantErrorResponses[404], { error: 'customer_not_found' });
    assertValid(tenantErrorResponses[400], {
      error: 'invalid_request',
      details: 'from must be earlier than to',
    });
  });

  /**
   * The example on the page is the first thing a reader trusts and the last
   * thing anything checks. Field-level examples used to be composed into one
   * per bucket, which published a body whose breakdowns each carried the grand
   * total and could not sum to it. Pinning each published example to the golden
   * closes the loop: the integration suite proves the golden is what the
   * database returns, so the documented example is a real response.
   */
  it.each([
    ['customer summary', customerSummaryResponse, goldenSummary],
    ['endpoint detail', customerEndpointsResponse, goldenEndpoints],
    ['user detail', customerUsersResponse, goldenUsers],
  ])(
    'publishes a real response as the %s example',
    (_label, schema, golden) => {
      expect(schema.examples[0]).toEqual(golden);
    },
  );

  it('publishes a real decomposed response as the second summary example', () => {
    // The page shows two dimensions rather than all four so it stays readable,
    // so it has to be the golden narrowed to exactly those keys.
    const [, decomposed] = customerSummaryResponse.examples;
    const shown = Object.keys(decomposed.breakdowns);
    expect(shown).not.toHaveLength(0);
    expect(decomposed).toEqual({
      ...goldenSummary,
      breakdowns: Object.fromEntries(
        shown.map((dimension) => [
          dimension,
          goldenSummaryBreakdowns.breakdowns[
            dimension as keyof typeof goldenSummaryBreakdowns.breakdowns
          ],
        ]),
      ),
    });
  });

  it('publishes a real response as the top customers example', () => {
    // The example shows a shorter list than the golden so the page stays
    // readable, so it is the same ranking truncated to its own limit.
    const [example] = topCustomersResponse.examples;
    expect(example).toEqual({
      ...goldenTopCustomers,
      limit: example.limit,
      customers: goldenTopCustomers.customers.slice(0, example.limit),
    });
  });

  it.each([
    ['customer summary', customerSummaryResponse],
    ['endpoint detail', customerEndpointsResponse],
    ['user detail', customerUsersResponse],
    ['top customers', topCustomersResponse],
  ])('validates its own %s example', (_label, schema) => {
    assertValid(schema, schema.examples[0]);
  });

  it('is strict enough to catch drift', () => {
    const validate = ajv.compile(customerSummaryResponse);
    const undocumentedField = { ...goldenSummary, invoice_total: 1200 };
    const missingRequiredField: Partial<typeof goldenSummary> =
      structuredClone(goldenSummary);
    delete missingRequiredField.totals;
    const wrongBucketType = {
      ...goldenSummary,
      breakdowns: {
        plan: [{ plan: 'free', event_count: '3', total_duration_ms: 6458 }],
      },
    };
    // A dimension we never published cannot appear just because a client asked
    // for it, which is what keeps `breakdown` a closed vocabulary end to end.
    const undocumentedDimension = {
      ...goldenSummary,
      breakdowns: {
        user_email: [
          { user_email: 'a@b.co', event_count: 3, total_duration_ms: 6458 },
        ],
      },
    };

    expect(validate(undocumentedField)).toBe(false);
    expect(validate(missingRequiredField)).toBe(false);
    expect(validate(wrongBucketType)).toBe(false);
    expect(validate(undocumentedDimension)).toBe(false);
  });
});

describe('aggregate conversion', () => {
  it('converts safe bigints and refuses to round unsafe ones', () => {
    expect(toJsonInteger(42n)).toBe(42);
    expect(() =>
      toJsonInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrowError(expect.objectContaining({ name: 'MetricRangeError' }));
  });
});
