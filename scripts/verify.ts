import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';

import postgres from 'postgres';

import { summaryDimensions } from '../src/queries/usage.js';
import {
  goldenEndpoints,
  goldenSummary,
  goldenSummaryBreakdowns,
  goldenTopCustomers,
  goldenUsers,
} from '../src/tests/goldenResponses.js';
import { resetDatabase, startTestDatabase } from './testDatabase.js';

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(' ')} exited ${String(code)}`),
        );
    });
  });
}

function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed: ${stderr}`));
    });
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup races are expected while the child binds its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Built API did not become healthy');
}

async function json(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

await run('pnpm', ['format:check']);
await run('pnpm', ['lint']);
await run('pnpm', ['typecheck']);
await run('pnpm', ['build']);
await run('pnpm', ['test:unit']);

const database = await startTestDatabase();
let api: ChildProcess | undefined;
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POSTGRES_ADMIN_URL: database.urls.admin,
    MIGRATOR_DATABASE_URL: database.urls.migrator,
    INGEST_DATABASE_URL: database.urls.ingest,
    TENANT_DATABASE_URL: database.urls.tenant,
    BILLING_ADMIN_DATABASE_URL: database.urls.billingAdmin,
    INTELITICS_REUSE_TEST_DATABASE: 'true',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
  await resetDatabase(database.urls.migrator);

  const first = JSON.parse(
    (
      await capture(
        'pnpm',
        ['ingest', '--', 'data/fixtures/usage_events.json'],
        env,
      )
    ).stdout,
  ) as Record<string, unknown>;
  assert.deepEqual(
    {
      status: first.status,
      accepted: first.accepted,
      duplicate: first.duplicate,
      rejected: first.rejected,
    },
    { status: 'succeeded', accepted: 417, duplicate: 16, rejected: 9 },
  );

  await mkdir('.tmp', { recursive: true });
  await copyFile('data/fixtures/usage_events.json', '.tmp/usage-copy.json');
  const skipped = JSON.parse(
    (await capture('pnpm', ['ingest', '--', '.tmp/usage-copy.json'], env))
      .stdout,
  ) as Record<string, unknown>;
  assert.deepEqual(
    {
      status: skipped.status,
      source_duplicate: skipped.source_duplicate,
      processed: skipped.processed,
    },
    { status: 'skipped', source_duplicate: true, processed: 0 },
  );

  const sql = postgres(database.urls.ingest, { max: 1 });
  try {
    const [state] = await sql<
      {
        facts: number;
        rejections: number;
        sources: number;
      }[]
    >`
      select
        (select count(*)::int from app.usage_events) as facts,
        (select count(*)::int from app.ingest_rejections) as rejections,
        (select count(*)::int from app.ingest_sources) as sources
    `;
    assert.deepEqual(state, {
      facts: 417,
      rejections: 9,
      sources: 1,
    });
  } finally {
    await sql.end();
  }

  const port = await freePort();
  env.PORT = String(port);
  api = spawn(process.execPath, ['dist/api/server.js'], {
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const range = 'from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z';

  assert.deepEqual(
    await json(`${baseUrl}/customers/cust_006/usage?${range}`, {
      'x-customer-id': 'cust_006',
    }),
    goldenSummary,
  );
  assert.deepEqual(
    await json(
      `${baseUrl}/customers/cust_006/usage?${range}` +
        `&breakdown=${summaryDimensions.join(',')}`,
      { 'x-customer-id': 'cust_006' },
    ),
    goldenSummaryBreakdowns,
  );
  assert.deepEqual(
    await json(`${baseUrl}/customers/cust_006/usage/endpoints?${range}`, {
      'x-customer-id': 'cust_006',
    }),
    goldenEndpoints,
  );
  assert.deepEqual(
    await json(`${baseUrl}/customers/cust_006/usage/users?${range}`, {
      'x-customer-id': 'cust_006',
    }),
    goldenUsers,
  );
  assert.deepEqual(
    await json(`${baseUrl}/usage/top-customers?${range}&limit=10`, {
      'x-admin': 'true',
    }),
    goldenTopCustomers,
  );

  const failures = [
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
    // A dimension we do not publish is refused, not silently ignored.
    [
      `/customers/cust_006/usage?${range}&breakdown=user_email`,
      { 'x-customer-id': 'cust_006' },
      400,
      'invalid_request',
    ],
    [`/usage/top-customers?${range}`, {}, 403, 'admin_required'],
    [
      `/customers/cust_missing/usage?${range}`,
      { 'x-customer-id': 'cust_missing' },
      404,
      'customer_not_found',
    ],
  ] as const;
  for (const [pathname, headers, status, error] of failures) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    assert.equal(response.status, status);
    assert.equal(((await response.json()) as { error: string }).error, error);
  }

  await stopChild(api);
  api = undefined;
  await run('pnpm', ['test:integration'], env);
} finally {
  await stopChild(api);
  await rm('.tmp', { recursive: true, force: true });
  await database.stop();
}
