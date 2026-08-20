import 'dotenv/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

export interface DatabaseClient {
  db: PostgresJsDatabase<typeof schema>;
  sql: Sql;
  close: () => Promise<void>;
}

export function createDatabaseClient(url: string, max = 10): DatabaseClient {
  const sql = postgres(url, {
    max,
    onnotice: () => undefined,
    transform: { undefined: null },
  });
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: async () => {
      await sql.end();
    },
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const createMigratorClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('MIGRATOR_DATABASE_URL'), 2);

export const createIngestClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('INGEST_DATABASE_URL'), 2);

export const createTenantClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('TENANT_DATABASE_URL'));

export const createBillingAdminClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('BILLING_ADMIN_DATABASE_URL'));
