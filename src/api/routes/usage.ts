import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';

import type { DatabaseClient } from '../../db/client.js';
import {
  groupedRows,
  summarizeUsage,
  type GroupedMetric,
  type Metric,
} from '../../queries/summarizeUsage.js';
import {
  parseTopCustomersQuery,
  parseUsageWindow,
  requireAdmin,
  requireTenantIdentity,
} from '../validation.js';

export interface UsageRouteClients {
  tenant: DatabaseClient;
  billingAdmin: DatabaseClient;
}

interface CustomerParams {
  id: string;
}

function asMetric(value: Metric | GroupedMetric[]): Metric {
  if (Array.isArray(value)) throw new Error('Expected aggregate metric');
  return value;
}

function asGroups(value: Metric | GroupedMetric[]): GroupedMetric[] {
  if (!Array.isArray(value)) throw new Error('Expected grouped metrics');
  return value;
}

async function withTenant<T>(
  client: DatabaseClient,
  customerId: string,
  callback: (sql: Sql) => Promise<T>,
): Promise<T> {
  return client.sql.begin(async (transaction) => {
    await transaction`select set_config('app.current_customer_id', ${customerId}, true)`;
    const [customer] = await transaction<{ id: string }[]>`
      select id from app.customers where id = ${customerId}
    `;
    if (!customer) {
      throw Object.assign(new Error('Customer not found'), {
        statusCode: 404,
        code: 'customer_not_found',
      });
    }
    return callback(transaction as unknown as Sql);
  }) as Promise<T>;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  clients: UsageRouteClients,
): void {
  app.get<{ Params: CustomerParams }>(
    '/customers/:id/usage',
    async (request) => {
      const { id } = request.params;
      requireTenantIdentity(request.headers['x-customer-id'], id);
      const window = parseUsageWindow(request.query as Record<string, unknown>);

      return withTenant(clients.tenant, id, async (sql) => {
        const totals = await summarizeUsage({
          sql,
          customerId: id,
          ...window,
          groupBy: 'none',
        });
        const byEventType = await summarizeUsage({
          sql,
          customerId: id,
          ...window,
          groupBy: 'event_type',
        });
        const byStatus = await summarizeUsage({
          sql,
          customerId: id,
          ...window,
          groupBy: 'status',
        });
        const byPlan = await summarizeUsage({
          sql,
          customerId: id,
          ...window,
          groupBy: 'plan',
        });
        return {
          customer_id: id,
          from: window.fromIso,
          to: window.toIso,
          totals: asMetric(totals),
          by_event_type: groupedRows('event_type', asGroups(byEventType)),
          by_status: groupedRows('status', asGroups(byStatus)),
          by_plan: groupedRows('plan', asGroups(byPlan)),
        };
      });
    },
  );

  app.get<{ Params: CustomerParams }>(
    '/customers/:id/usage/endpoints',
    async (request) => {
      const { id } = request.params;
      requireTenantIdentity(request.headers['x-customer-id'], id);
      const window = parseUsageWindow(request.query as Record<string, unknown>);
      return withTenant(clients.tenant, id, async (sql) => ({
        customer_id: id,
        from: window.fromIso,
        to: window.toIso,
        endpoints: groupedRows(
          'endpoint',
          asGroups(
            await summarizeUsage({
              sql,
              customerId: id,
              ...window,
              groupBy: 'endpoint',
            }),
          ),
        ),
      }));
    },
  );

  app.get<{ Params: CustomerParams }>(
    '/customers/:id/usage/users',
    async (request) => {
      const { id } = request.params;
      requireTenantIdentity(request.headers['x-customer-id'], id);
      const window = parseUsageWindow(request.query as Record<string, unknown>);
      return withTenant(clients.tenant, id, async (sql) => ({
        customer_id: id,
        from: window.fromIso,
        to: window.toIso,
        users: groupedRows(
          'user_email',
          asGroups(
            await summarizeUsage({
              sql,
              customerId: id,
              ...window,
              groupBy: 'user_email',
            }),
          ),
        ),
      }));
    },
  );

  app.get('/usage/top-customers', async (request) => {
    requireAdmin(request.headers['x-admin']);
    const window = parseTopCustomersQuery(
      request.query as Record<string, unknown>,
    );
    const customers = asGroups(
      await summarizeUsage({
        sql: clients.billingAdmin.sql,
        ...window,
        groupBy: 'customer_id',
        orderBy: 'event_count',
        limit: window.limit,
      }),
    );
    return {
      from: window.fromIso,
      to: window.toIso,
      limit: window.limit,
      customers: groupedRows('customer_id', customers),
    };
  });
}
