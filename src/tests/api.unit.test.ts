import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminPrincipal,
  authorizeCustomer,
  tenantPrincipal,
} from '../api/principal.js';
import { buildServer } from '../api/server.js';
import {
  resolveTopCustomersQuery,
  resolveUsageWindow,
} from '../api/usageWindow.js';
import type { DatabaseClient } from '../db/client.js';
import { toJsonInteger } from '../queries/usage.js';

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
    db: unreachable as unknown as DatabaseClient['db'],
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

  it('requires the exact admin grant', async () => {
    const response = await app.inject({
      url: `/usage/top-customers?${range}`,
      headers: { 'x-admin': 'True' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'admin_required' });
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

describe('aggregate conversion', () => {
  it('converts safe bigints and refuses to round unsafe ones', () => {
    expect(toJsonInteger(42n)).toBe(42);
    expect(() =>
      toJsonInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrowError(expect.objectContaining({ name: 'MetricRangeError' }));
  });
});
