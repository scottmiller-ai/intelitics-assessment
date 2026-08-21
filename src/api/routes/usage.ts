import type { FastifyInstance } from 'fastify';

import type { DatabaseClient } from '../../db/client.js';
import { withTenantScope } from '../../db/tenantSession.js';
import {
  selectCustomerEndpointDetail,
  selectCustomerUsageByUserEmail,
  selectCustomerUsageSummary,
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
  type CustomerEndpoints,
  customerEndpointsResponse,
  customerParams,
  type CustomerParams,
  type CustomerSummary,
  customerSummaryResponse,
  type CustomerUsers,
  customerUsersResponse,
  summaryQuery,
  type SummaryQuery,
  tenantErrorResponses,
  tenantHeaders,
  type TenantHeaders,
  type TopCustomers,
  topCustomersQuery,
  type TopCustomersQuery,
  topCustomersResponse,
  usageWindowQuery,
  type UsageWindowQuery,
} from '../schemas.js';
import {
  resolveBreakdown,
  resolveTopCustomersQuery,
  resolveUsageWindow,
} from '../usageWindow.js';

export interface UsageRouteClients {
  tenant: DatabaseClient;
  billingAdmin: DatabaseClient;
}

/**
 * `Reply` is the published response schema's own type, so a handler that stops
 * matching what `/docs` promises fails to compile.
 */
interface TenantRoute<Reply, Query = UsageWindowQuery> {
  Params: CustomerParams;
  Querystring: Query;
  Headers: TenantHeaders;
  Reply: Reply;
}

interface AdminRoute {
  Querystring: TopCustomersQuery;
  Headers: AdminHeaders;
  Reply: TopCustomers;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  clients: UsageRouteClients,
): void {
  app.get<TenantRoute<CustomerSummary, SummaryQuery>>(
    '/customers/:id/usage',
    {
      schema: {
        operationId: 'getCustomerUsage',
        tags: ['tenant'],
        summary: 'Customer usage summary',
        description:
          'What this customer used in the window. Totals only unless `breakdown` names dimensions to decompose them by, so the response size is the caller\u2019s choice rather than ours.',
        params: customerParams,
        headers: tenantHeaders,
        querystring: summaryQuery,
        response: { 200: customerSummaryResponse, ...tenantErrorResponses },
      },
    },
    async (request) => {
      const principal = tenantPrincipal(request.headers['x-customer-id']);
      authorizeCustomer(principal, request.params.id);
      const window = resolveUsageWindow(request.query);
      const dimensions = resolveBreakdown(request.query.breakdown);

      return withTenantScope(
        clients.tenant,
        principal.customerId,
        async (sql) => ({
          customer_id: principal.customerId,
          from: window.fromIso,
          to: window.toIso,
          ...(await selectCustomerUsageSummary({
            sql,
            customerId: principal.customerId,
            dimensions,
            ...window,
          })),
        }),
      );
    },
  );

  app.get<TenantRoute<CustomerEndpoints>>(
    '/customers/:id/usage/endpoints',
    {
      schema: {
        operationId: 'getCustomerUsageByEndpoint',
        tags: ['tenant'],
        summary: 'Detailed customer usage per endpoint',
        description:
          'Per endpoint: totals, mean and slowest timed duration, and the producer-reported status split.',
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
          endpoints: await selectCustomerEndpointDetail({
            sql,
            customerId: principal.customerId,
            ...window,
          }),
        }),
      );
    },
  );

  app.get<TenantRoute<CustomerUsers>>(
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
          'Cross-tenant ranking. Served by a read-only role whose cross-tenant reach is one RLS policy on one table, not a bypass.',
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
