import type { ISql } from 'postgres';

import type { DatabaseClient } from './client.js';

/**
 * `app.customers` is derived from ingest, so this means "no usage has been
 * recorded under this id", which is not quite the same as "no such customer".
 * The message says what the data can actually support. See DESIGN.md.
 */
export class CustomerNotFoundError extends Error {
  constructor(readonly customerId: string) {
    super('No usage has been recorded for this customer id');
    this.name = 'CustomerNotFoundError';
  }
}

/**
 * One connection, one transaction, one tenant. `set_config(..., true)` is
 * transaction-local, so the context cannot leak to the next borrower of this
 * pooled connection. RLS on `app.customers` is what makes the existence check
 * below a tenant-scoped answer rather than a global one.
 *
 * Repeatable read covers the pair of statements below: the existence check and
 * the aggregate that follows it. Under read committed each takes a fresh
 * snapshot, so a concurrent ingest commit could let a request confirm a
 * customer and then report totals from a different version of the table. The
 * aggregates themselves are single statements and do not need this; the seam
 * between the check and the answer does.
 */
export function withTenantScope<T>(
  client: DatabaseClient,
  customerId: string,
  run: (sql: ISql) => Promise<T>,
) {
  return client.sql.begin(
    'isolation level repeatable read',
    async (transaction) => {
      await transaction`select set_config('app.current_customer_id', ${customerId}, true)`;
      const [customer] = await transaction<{ id: string }[]>`
        select id from app.customers where id = ${customerId}
      `;
      if (!customer) {
        throw new CustomerNotFoundError(customerId);
      }
      return run(transaction);
    },
  );
}
