import path from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface TestDatabase {
  urls: {
    admin: string;
    migrator: string;
    ingest: string;
    tenant: string;
    billingAdmin: string;
  };
  stop: () => Promise<void>;
}

const roleVariables = [
  'POSTGRES_ADMIN_URL',
  'MIGRATOR_DATABASE_URL',
  'INGEST_DATABASE_URL',
  'TENANT_DATABASE_URL',
  'BILLING_ADMIN_DATABASE_URL',
] as const;

const reusableTestDatabaseFlag = 'INTELITICS_REUSE_TEST_DATABASE';

function roleUrl(adminUrl: string, username: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function reusableUrls(): TestDatabase['urls'] {
  const missing = roleVariables.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `${reusableTestDatabaseFlag}=true requires ${missing.join(', ')}`,
    );
  }

  const parsed = roleVariables.map(
    (name) => [name, new URL(process.env[name]!)] as const,
  );
  const databaseNames = new Set(parsed.map(([, url]) => url.pathname));
  if (databaseNames.size !== 1 || !parsed[0]?.[1].pathname.endsWith('_test')) {
    throw new Error(
      'Reusable integration-test URLs must target the same database with a name ending in _test',
    );
  }

  return {
    admin: process.env.POSTGRES_ADMIN_URL!,
    migrator: process.env.MIGRATOR_DATABASE_URL!,
    ingest: process.env.INGEST_DATABASE_URL!,
    tenant: process.env.TENANT_DATABASE_URL!,
    billingAdmin: process.env.BILLING_ADMIN_DATABASE_URL!,
  };
}

export async function startTestDatabase(): Promise<TestDatabase> {
  if (process.env[reusableTestDatabaseFlag] === 'true') {
    return {
      urls: reusableUrls(),
      stop: () => Promise.resolve(),
    };
  }

  let container: StartedPostgreSqlContainer | undefined;
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intelitics_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    const admin = container.getConnectionUri();
    const urls = {
      admin,
      migrator: roleUrl(admin, 'migrator', 'migrator'),
      ingest: roleUrl(admin, 'ingest_app', 'ingest_app'),
      tenant: roleUrl(admin, 'tenant_app', 'tenant_app'),
      billingAdmin: roleUrl(admin, 'billing_admin', 'billing_admin'),
    };

    const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
    try {
      await adminSql.file(path.resolve('db/bootstrap.sql'));
    } finally {
      await adminSql.end();
    }

    const migratorSql = postgres(urls.migrator, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await migrate(drizzle(migratorSql), {
        migrationsFolder: path.resolve('drizzle'),
        migrationsSchema: 'app',
        migrationsTable: '__drizzle_migrations',
      });
    } finally {
      await migratorSql.end();
    }

    process.env.POSTGRES_ADMIN_URL = urls.admin;
    process.env.MIGRATOR_DATABASE_URL = urls.migrator;
    process.env.INGEST_DATABASE_URL = urls.ingest;
    process.env.TENANT_DATABASE_URL = urls.tenant;
    process.env.BILLING_ADMIN_DATABASE_URL = urls.billingAdmin;

    return {
      urls,
      stop: async () => {
        await container?.stop();
      },
    };
  } catch (error) {
    await container?.stop();
    throw error;
  }
}

export async function resetDatabase(migratorUrl: string): Promise<void> {
  const sql = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      truncate app.ingest_rejections,
        app.usage_events,
        app.ingest_sources,
        app.customers
      restart identity
    `;
  } finally {
    await sql.end();
  }
}
