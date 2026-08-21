import type { FastifyInstance } from 'fastify';

import { healthResponse } from '../schemas.js';
import type { UsageRouteClients } from './usage.js';

export function registerHealthRoute(
  app: FastifyInstance,
  clients: UsageRouteClients,
): void {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        tags: ['ops'],
        summary: 'Serving-pool connectivity',
        description:
          'Both serving roles can reach the tables they need. Not ingest health, and not a check of tenant RLS.',
        response: { 200: healthResponse, 503: healthResponse },
      },
    },
    async (_request, reply) => {
      try {
        await Promise.all([
          clients.tenant.sql.begin(async (transaction) => {
            await transaction`set local statement_timeout = '2000ms'`;
            await transaction`select 1 from app.customers limit 1`;
          }),
          clients.billingAdmin.sql.begin(async (transaction) => {
            await transaction`set local statement_timeout = '2000ms'`;
            await transaction`select 1 from app.usage_events limit 1`;
          }),
        ]);
        return { status: 'ok', database: 'ready' };
      } catch {
        return reply
          .status(503)
          .send({ status: 'unavailable', database: 'unavailable' });
      }
    },
  );
}
