import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  createBillingAdminClient,
  createTenantClient,
  type DatabaseClient,
} from '../db/client.js';
import { registerUsageRoutes, type UsageRouteClients } from './routes/usage.js';
import { RequestValidationError } from './validation.js';

interface CodedError extends Error {
  statusCode?: number;
  code?: string;
}

export async function buildServer(
  suppliedClients?: UsageRouteClients,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });
  const ownsClients = suppliedClients === undefined;
  const clients: UsageRouteClients = suppliedClients ?? {
    tenant: createTenantClient(),
    billingAdmin: createBillingAdminClient(),
  };

  app.setErrorHandler((error: CodedError, request, reply) => {
    if (error instanceof RequestValidationError) {
      void reply
        .status(400)
        .send({ error: 'invalid_request', details: error.message });
      return;
    }
    if (error.code && error.statusCode) {
      void reply
        .status(error.statusCode)
        .send({ error: error.code, details: error.message });
      return;
    }
    request.log.error({ err: error }, 'Request failed');
    void reply
      .status(500)
      .send({ error: 'internal_error', details: 'Unexpected failure' });
  });

  app.get('/health', async (_request, reply) => {
    try {
      await clients.tenant.sql`select 1`;
      return { status: 'ok', database: 'ready' };
    } catch {
      return reply
        .status(503)
        .send({ status: 'unavailable', database: 'unavailable' });
    }
  });

  registerUsageRoutes(app, clients);

  if (ownsClients) {
    app.addHook('onClose', async () => {
      await Promise.all([
        closeClient(clients.tenant),
        closeClient(clients.billingAdmin),
      ]);
    });
  }
  return app;
}

async function closeClient(client: DatabaseClient): Promise<void> {
  await client.close();
}

async function start(): Promise<void> {
  const app = await buildServer();
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '3000');
  await app.listen({ host, port });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await start();
}
