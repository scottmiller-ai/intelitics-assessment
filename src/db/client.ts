import 'dotenv/config';
import postgres, { type Sql } from 'postgres';

export interface DatabaseClient {
  sql: Sql;
  close: () => Promise<void>;
}

interface PoolOptions {
  max: number;
  /** Seconds to wait for a socket and handshake, not for a pool slot. */
  connectTimeout: number;
  /** Server-side ceiling for every statement on this pool, in milliseconds. */
  statementTimeout?: number;
}

export function createDatabaseClient(
  url: string,
  options: PoolOptions,
): DatabaseClient {
  const sql = postgres(url, {
    max: options.max,
    connect_timeout: options.connectTimeout,
    connection:
      options.statementTimeout === undefined
        ? {}
        : { statement_timeout: options.statementTimeout },
    onnotice: () => undefined,
    transform: { undefined: null },
  });
  return {
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
  createDatabaseClient(requireEnv('MIGRATOR_DATABASE_URL'), {
    max: 2,
    connectTimeout: 30,
  });

/**
 * Ingest holds one transaction open for a whole source, so it gets no statement
 * timeout. Its safety property is the advisory lock, not a clock.
 */
export const createIngestClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('INGEST_DATABASE_URL'), {
    max: 2,
    connectTimeout: 30,
  });

/**
 * No billing aggregate holds a connection for more than 15 seconds, which is
 * what bounds a slow query. It is not what bounds a saturated pool: this driver
 * has no acquire timeout, so past ten concurrent requests the eleventh queues
 * rather than failing, for up to a statement timeout at a time. Bounding that
 * wait needs a deadline around the acquisition itself. See DESIGN.md.
 */
const servingPool = { max: 10, connectTimeout: 5, statementTimeout: 15_000 };

export const createTenantClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('TENANT_DATABASE_URL'), servingPool);

export const createBillingAdminClient = (): DatabaseClient =>
  createDatabaseClient(requireEnv('BILLING_ADMIN_DATABASE_URL'), servingPool);
