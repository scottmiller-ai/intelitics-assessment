import type { Sql } from 'postgres';

import type { DatabaseClient } from './client.js';

export class CustomerNotFoundError extends Error {
  constructor(readonly customerId: string) {
    super('Customer not found');
    this.name = 'CustomerNotFoundError';
  }
}

/**
 * One connection, one transaction, one tenant. `set_config(..., true)` is
 * transaction-local, so the context cannot leak to the next borrower of this
 * pooled connection. RLS on `app.customers` is what makes the existence check
 * below a tenant-scoped answer rather than a global one.
 */
export async function withTenantScope<T>(
  client: DatabaseClient,
  customerId: string,
  run: (sql: Sql) => Promise<T>,
): Promise<T> {
  return client.sql.begin(async (transaction) => {
    await transaction`select set_config('app.current_customer_id', ${customerId}, true)`;
    const [customer] = await transaction<{ id: string }[]>`
      select id from app.customers where id = ${customerId}
    `;
    if (!customer) {
      throw new CustomerNotFoundError(customerId);
    }
    return run(transaction as unknown as Sql);
  }) as Promise<T>;
}
