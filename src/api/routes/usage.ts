import type { FastifyInstance } from 'fastify';

import type { DatabaseClient } from '../../db/client.js';
import { withTenantScope } from '../../db/tenantSession.js';
import {
  selectCustomerTotals,
  selectCustomerUsageByEndpoint,
  selectCustomerUsageByEventType,
  selectCustomerUsageByPlan,
  selectCustomerUsageByStatus,
  selectCustomerUsageByUserEmail,
  selectTopCustomers,
} from '../../queries/usage.js';
import {
  adminPrincipal,
  authorizeCustomer,
  tenantPrincipal,
} from '../principal.js';
import {
  adminErrorResponses,
  adminHeaders,
  type AdminHeaders,
  customerEndpointsResponse,
  customerParams,
  type CustomerParams,
  customerSummaryResponse,
  customerUsersResponse,
  tenantErrorResponses,
  tenantHeaders,
  type TenantHeaders,
  topCustomersQuery,
  type TopCustomersQuery,
  topCustomersResponse,
  usageWindowQuery,
  type UsageWindowQuery,
} from '../schemas.js';
import {
  resolveTopCustomersQuery,
  resolveUsageWindow,
} from '../usageWindow.js';

export interface UsageRouteClients {
  tenant: DatabaseClient;
  billingAdmin: DatabaseClient;
}

interface TenantRoute {
  Params: CustomerParams;
  Querystring: UsageWindowQuery;
  Headers: TenantHeaders;
}

interface AdminRoute {
  Querystring: TopCustomersQuery;
  Headers: AdminHeaders;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  clients: UsageRouteClients,
): void {
  app.get<TenantRoute>(
    '/customers/:id/usage',
    {
      schema: {
        operationId: 'getCustomerUsage',
        tags: ['tenant'],
        summary: 'Customer usage summary',
        description:
          'Totals for the window plus a bucket per event type, status, and event-time plan.',
        params: customerParams,
        headers: tenantHeaders,
        querystring: usageWindowQuery,
        response: { 200: customerSummaryResponse, ...tenantErrorResponses },
      },
    },
    async (request) => {
      const principal = tenantPrincipal(request.headers['x-customer-id']);
      authorizeCustomer(principal, request.params.id);
      const window = resolveUsageWindow(request.query);

      return withTenantScope(
        clients.tenant,
        principal.customerId,
        async (sql) => {
          const scope = { sql, customerId: principal.customerId, ...window };
          // Awaited in order: all four share one transaction on one connection.
          return {
            customer_id: principal.customerId,
            from: window.fromIso,
            to: window.toIso,
            totals: await selectCustomerTotals(scope),
            by_event_type: await selectCustomerUsageByEventType(scope),
            by_status: await selectCustomerUsageByStatus(scope),
            by_plan: await selectCustomerUsageByPlan(scope),
          };
        },
      );
    },
  );

  app.get<TenantRoute>(
    '/customers/:id/usage/endpoints',
    {
      schema: {
        operationId: 'getCustomerUsageByEndpoint',
        tags: ['tenant'],
        summary: 'Customer usage by endpoint',
        params: customerParams,
        headers: tenantHeaders,
        querystring: usageWindowQuery,
        response: { 200: customerEndpointsResponse, ...tenantErrorResponses },
      },
    },
    async (request) => {
      const principal = tenantPrincipal(request.headers['x-customer-id']);
      authorizeCustomer(principal, request.params.id);
      const window = resolveUsageWindow(request.query);

      return withTenantScope(
        clients.tenant,
        principal.customerId,
        async (sql) => ({
          customer_id: principal.customerId,
          from: window.fromIso,
          to: window.toIso,
          endpoints: await selectCustomerUsageByEndpoint({
            sql,
            customerId: principal.customerId,
            ...window,
          }),
        }),
      );
    },
  );

  app.get<TenantRoute>(
    '/customers/:id/usage/users',
    {
      schema: {
        operationId: 'getCustomerUsageByUser',
        tags: ['tenant'],
        summary: 'Customer usage by user email',
        description:
          'Showback view. Emails are producer-supplied PII and are never used to infer tenancy.',
        params: customerParams,
        headers: tenantHeaders,
        querystring: usageWindowQuery,
        response: { 200: customerUsersResponse, ...tenantErrorResponses },
      },
    },
    async (request) => {
      const principal = tenantPrincipal(request.headers['x-customer-id']);
      authorizeCustomer(principal, request.params.id);
      const window = resolveUsageWindow(request.query);

      return withTenantScope(
        clients.tenant,
        principal.customerId,
        async (sql) => ({
          customer_id: principal.customerId,
          from: window.fromIso,
          to: window.toIso,
          users: await selectCustomerUsageByUserEmail({
            sql,
            customerId: principal.customerId,
            ...window,
          }),
        }),
      );
    },
  );

  app.get<AdminRoute>(
    '/usage/top-customers',
    {
      schema: {
        operationId: 'getTopCustomers',
        tags: ['admin'],
        summary: 'Top customers by usage',
        description:
          'Cross-tenant ranking. Served by a role that bypasses RLS and cannot write.',
        headers: adminHeaders,
        querystring: topCustomersQuery,
        response: { 200: topCustomersResponse, ...adminErrorResponses },
      },
    },
    async (request) => {
      adminPrincipal(request.headers['x-admin']);
      const window = resolveTopCustomersQuery(request.query);

      return {
        from: window.fromIso,
        to: window.toIso,
        limit: window.limit,
        customers: await selectTopCustomers({
          sql: clients.billingAdmin.sql,
          ...window,
        }),
      };
    },
  );
}
