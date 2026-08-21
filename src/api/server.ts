import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  createBillingAdminClient,
  createTenantClient,
  type DatabaseClient,
} from '../db/client.js';
import { registerDocs } from './docs.js';
import { registerErrorHandler } from './errors.js';
import { registerHealthRoute } from './routes/health.js';
import { registerUsageRoutes, type UsageRouteClients } from './routes/usage.js';

export async function buildServer(
  suppliedClients?: UsageRouteClients,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Fastify strips unknown properties by default. A billing window is worth
    // rejecting outright: a typo like `form=` must not silently widen the range.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ownsClients = suppliedClients === undefined;
  const clients: UsageRouteClients = suppliedClients ?? {
    tenant: createTenantClient(),
    billingAdmin: createBillingAdminClient(),
  };

  registerErrorHandler(app);
  await registerDocs(app);
  registerHealthRoute(app, clients);
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
  const rawPort = process.env.PORT ?? '3000';
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
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
