import type { FastifyInstance } from 'fastify';
import type { ISql } from 'postgres';

import type { DatabaseClient } from '../../db/client.js';
import { type Health, healthResponse } from '../schemas.js';
import type { UsageRouteClients } from './usage.js';

/**
 * Each probe proves one thing: this pool can borrow a connection and read the
 * table its routes depend on. The statement timeout bounds the query itself.
 * It does not bound the wait for a connection, so this reports on a saturated
 * pool by queueing behind it rather than by answering 503, and a pool deadline
 * is what would fix that. See DESIGN.md.
 */
async function probe(
  client: DatabaseClient,
  read: (sql: ISql) => Promise<unknown>,
): Promise<unknown> {
  try {
    await client.sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '2000ms'`;
      await read(transaction);
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

export function registerHealthRoute(
  app: FastifyInstance,
  clients: UsageRouteClients,
): void {
  app.get<{ Reply: Health }>(
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
    async (request, reply) => {
      const [tenant, billingAdmin] = await Promise.all([
        probe(
          clients.tenant,
          (sql) => sql`select 1 from app.customers limit 1`,
        ),
        probe(
          clients.billingAdmin,
          (sql) => sql`select 1 from app.usage_events limit 1`,
        ),
      ]);
      if (tenant === undefined && billingAdmin === undefined) {
        return { status: 'ok', database: 'ready' };
      }

      // Name the pool that failed. A red check with no reason costs on-call the
      // first ten minutes of every incident.
      request.log.error(
        {
          err: tenant ?? billingAdmin,
          pools: [
            ...(tenant === undefined ? [] : ['tenant']),
            ...(billingAdmin === undefined ? [] : ['billing_admin']),
          ],
        },
        'Health probe could not reach Postgres',
      );
      return reply
        .status(503)
        .send({ status: 'unavailable', database: 'unavailable' });
    },
  );
}
