import { createHash } from 'node:crypto';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  resetDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../scripts/testDatabase.js';
import { buildServer } from '../api/server.js';
import {
  createBillingAdminClient,
  createIngestClient,
  createTenantClient,
} from '../db/client.js';
import { hashFileSource, type HashedSource } from '../ingest/hashSource.js';
import { ingestHashedSource } from '../ingest/persistBatch.js';
import {
  goldenEndpoints,
  goldenSummary,
  goldenTopCustomers,
  goldenUsers,
} from './goldenResponses.js';

const range = 'from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z';
const fixturePath = path.resolve('data/fixtures/usage_events.json');

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(async () => {
  await resetDatabase(database.urls.migrator);
});

async function seed(): Promise<void> {
  const client = createIngestClient();
  try {
    await ingestHashedSource(await hashFileSource(fixturePath), { client });
  } finally {
    await client.close();
  }
}

async function seededApp(): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  await seed();
  const tenant = createTenantClient();
  const billingAdmin = createBillingAdminClient();
  const app = await buildServer({ tenant, billingAdmin });
  return {
    app,
    close: async () => {
      await app.close();
      await Promise.all([tenant.close(), billingAdmin.close()]);
    },
  };
}

function inMemorySource(value: unknown, name = 'memory.json'): HashedSource {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    bytes,
    byteSize: bytes.byteLength,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceUri: name,
  };
}

describe('source orchestration', () => {
  it('ingests once and skips identical bytes under another filename', async () => {
    const source = await hashFileSource(fixturePath);
    const client = createIngestClient();
    try {
      await expect(
        ingestHashedSource(source, { client }),
      ).resolves.toMatchObject({
        status: 'succeeded',
        accepted: 417,
        duplicate: 16,
        rejected: 9,
        rejected_by_reason: {
          ambiguous_occurred_at: 3,
          missing_customer_id: 3,
          missing_occurred_at: 3,
        },
      });
      await expect(
        ingestHashedSource({ ...source, sourceUri: 'copied.json' }, { client }),
      ).resolves.toMatchObject({
        status: 'skipped',
        source_duplicate: true,
        processed: 0,
      });
      const [counts] = await client.sql<
        { facts: string; rejections: string; sources: string }[]
      >`
        select
          (select count(*) from app.usage_events)::text as facts,
          (select count(*) from app.ingest_rejections)::text as rejections,
          (select count(*) from app.ingest_sources)::text as sources
      `;
      expect(counts).toEqual({
        facts: '417',
        rejections: '9',
        sources: '1',
      });
    } finally {
      await client.close();
    }
  });

  it('serializes concurrent attempts at the source boundary', async () => {
    const source = await hashFileSource(fixturePath);
    const first = createIngestClient();
    const second = createIngestClient();
    try {
      const results = await Promise.all([
        ingestHashedSource(source, { client: first }),
        ingestHashedSource(source, { client: second }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'skipped',
        'succeeded',
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('rejects source failures before persistence and rolls back database failures', async () => {
    const client = createIngestClient();
    try {
      const invalidBytes = Buffer.from('{');
      await expect(
        ingestHashedSource(
          {
            bytes: invalidBytes,
            byteSize: 1,
            contentSha256: createHash('sha256')
              .update(invalidBytes)
              .digest('hex'),
            sourceUri: 'invalid.json',
          },
          { client },
        ),
      ).rejects.toMatchObject({ code: 'invalid_json' });

      const invalidUtf8 = Buffer.from([0xff]);
      await expect(
        ingestHashedSource(
          {
            bytes: invalidUtf8,
            byteSize: invalidUtf8.byteLength,
            contentSha256: createHash('sha256')
              .update(invalidUtf8)
              .digest('hex'),
            sourceUri: 'invalid-utf8.json',
          },
          { client },
        ),
      ).rejects.toMatchObject({ code: 'invalid_utf8' });

      const databaseFailure = inMemorySource([
        {
          customer_id: 'cust_rollback',
          event_type: 'login',
          occurred_at: '2026-07-01T00:00:00Z',
        },
      ]);
      await expect(
        ingestHashedSource(
          { ...databaseFailure, sourceUri: 'bad\u0000source' },
          { client },
        ),
      ).rejects.toMatchObject({ code: 'database_error' });

      await expect(
        ingestHashedSource(
          inMemorySource([
            {
              customer_id: 'cust_ok',
              event_type: 'login',
              occurred_at: '2026-07-01T00:00:00Z',
            },
            {
              customer_id: 'bad\u0000customer',
              event_type: 'login',
              occurred_at: '2026-07-01T00:00:00Z',
            },
          ]),
          { client },
        ),
      ).resolves.toMatchObject({
        status: 'succeeded',
        accepted: 1,
        rejected: 1,
        rejected_by_reason: { invalid_customer_id: 1 },
      });

      const [row] = await client.sql<
        {
          sources: string;
          facts: string;
          rejections: string;
        }[]
      >`
        select
          (select count(*) from app.ingest_sources)::text as sources,
          (select count(*) from app.usage_events)::text as facts,
          (select count(*) from app.ingest_rejections)::text as rejections
      `;
      expect(row).toEqual({
        sources: '1',
        facts: '1',
        rejections: '1',
      });
    } finally {
      await client.close();
    }
  });
});

describe('live usage API', () => {
  it('returns complete deterministic golden responses', async () => {
    const { app, close } = await seededApp();
    try {
      const summary = await app.inject({
        url: `/customers/cust_006/usage?${range}`,
        headers: { 'x-customer-id': 'cust_006' },
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toEqual(goldenSummary);

      const endpoints = await app.inject({
        url: `/customers/cust_006/usage/endpoints?${range}`,
        headers: { 'x-customer-id': 'cust_006' },
      });
      expect(endpoints.json()).toEqual(goldenEndpoints);

      const users = await app.inject({
        url: `/customers/cust_006/usage/users?${range}`,
        headers: { 'x-customer-id': 'cust_006' },
      });
      expect(users.json()).toEqual(goldenUsers);

      const top = await app.inject({
        url: `/usage/top-customers?${range}&limit=10`,
        headers: { 'x-admin': 'true' },
      });
      expect(top.json()).toEqual(goldenTopCustomers);
    } finally {
      await close();
    }
  });

  it('enforces half-open boundaries, empty windows, null groups, and defaults', async () => {
    await seed();
    const ingest = createIngestClient();
    try {
      await ingestHashedSource(
        inMemorySource(
          [
            '2026-07-01T00:00:00Z',
            '2026-07-15T00:00:00Z',
            '2026-08-01T00:00:00Z',
          ].map((occurred_at) => ({
            customer_id: 'cust_edge',
            event_type: 'boundary',
            occurred_at,
          })),
          'boundaries.json',
        ),
        { client: ingest },
      );
    } finally {
      await ingest.close();
    }

    const tenant = createTenantClient();
    const billingAdmin = createBillingAdminClient();
    const app = await buildServer({ tenant, billingAdmin });
    try {
      const boundary = await app.inject({
        url: `/customers/cust_edge/usage?${range}`,
        headers: { 'x-customer-id': 'cust_edge' },
      });
      expect(boundary.statusCode).toBe(200);
      expect(boundary.json()).toMatchObject({
        totals: { event_count: 2, total_duration_ms: 0 },
        by_plan: [{ plan: null, event_count: 2, total_duration_ms: 0 }],
      });

      const empty = await app.inject({
        url: '/customers/cust_edge/usage?from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z',
        headers: { 'x-customer-id': 'cust_edge' },
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({
        totals: { event_count: 0, total_duration_ms: 0 },
        by_event_type: [],
        by_status: [],
        by_plan: [],
      });

      const defaultWindow = await app.inject({
        url: '/customers/cust_edge/usage',
        headers: { 'x-customer-id': 'cust_edge' },
      });
      expect(defaultWindow.statusCode).toBe(200);
      const body = defaultWindow.json<{ from: string; to: string }>();
      expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(
        30 * 24 * 60 * 60 * 1000,
      );
    } finally {
      await app.close();
      await Promise.all([tenant.close(), billingAdmin.close()]);
    }
  });

  it('enforces the documented failure matrix', async () => {
    const { app, close } = await seededApp();
    try {
      const checks = [
        [
          `/customers/cust_006/usage?from=2026-07-01T00:00:00Z`,
          { 'x-customer-id': 'cust_006' },
          400,
          'invalid_request',
        ],
        [
          `/customers/cust_006/usage?${range}`,
          {},
          401,
          'customer_identity_required',
        ],
        [
          `/customers/cust_006/usage?${range}`,
          { 'x-customer-id': 'cust_005' },
          403,
          'tenant_mismatch',
        ],
        [`/usage/top-customers?${range}`, {}, 403, 'admin_required'],
        [
          `/customers/cust_missing/usage?${range}`,
          { 'x-customer-id': 'cust_missing' },
          404,
          'customer_not_found',
        ],
      ] as const;
      for (const [url, headers, status, code] of checks) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: code });
      }
    } finally {
      await close();
    }
  });
});

describe('database role isolation', () => {
  it('enforces RLS, transaction-local context, and least privilege', async () => {
    await seed();
    const tenant = postgres(database.urls.tenant);
    const ingest = postgres(database.urls.ingest);
    const billing = postgres(database.urls.billingAdmin);
    const admin = postgres(database.urls.admin);
    try {
      const visible = await tenant.begin(async (tx) => {
        await tx`select set_config('app.current_customer_id', 'cust_006', true)`;
        return tx<{ count: string }[]>`
          select count(*)::text as count from app.usage_events
        `;
      });
      expect(visible[0]?.count).toBe('3');
      expect(
        (
          await tenant<{ count: string }[]>`
        select count(*)::text as count from app.usage_events
      `
        )[0]?.count,
      ).toBe('0');
      await expect(tenant`select * from app.ingest_sources`).rejects.toThrow();

      expect(
        (
          await ingest<{ count: string }[]>`
        select count(*)::text as count from app.usage_events
      `
        )[0]?.count,
      ).toBe('417');
      await expect(
        ingest`create table app.forbidden(id int)`,
      ).rejects.toThrow();

      expect(
        (
          await billing<{ count: string }[]>`
        select count(*)::text as count from app.usage_events
      `
        )[0]?.count,
      ).toBe('417');
      await expect(
        billing`insert into app.customers(id) values ('forbidden')`,
      ).rejects.toThrow();

      const [privileges] = await admin<
        { schema_usage: boolean; table_select: boolean }[]
      >`
        select
          has_schema_privilege('public', 'app', 'usage') as schema_usage,
          has_table_privilege('public', 'app.usage_events', 'select') as table_select
      `;
      expect(privileges).toEqual({ schema_usage: false, table_select: false });
    } finally {
      await Promise.all([
        tenant.end(),
        ingest.end(),
        billing.end(),
        admin.end(),
      ]);
    }
  });
});
