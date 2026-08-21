import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

/**
 * The document is generated from the route schemas, so it cannot drift from
 * what the server actually validates and serializes.
 */
export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      // 3.1 is JSON Schema compatible, so nullable dimensions stay
      // `type: [string, null]` instead of needing a 3.0 `nullable` rewrite.
      openapi: '3.1.0',
      info: {
        title: 'Intelitics usage billing',
        version: '1.0.0',
        description: [
          'Named billing questions over ingested usage events.',
          'Windows are UTC half-open intervals: `from` inclusive, `to` exclusive.',
          'Omitting both bounds returns the last 30 days.',
          'Adapter headers stand in for verified identity claims and are not production authentication.',
        ].join(' '),
      },
      tags: [
        { name: 'ops', description: 'Process and dependency liveness' },
        {
          name: 'tenant',
          description: 'Single-customer usage, enforced by RLS',
        },
        { name: 'admin', description: 'Cross-tenant billing reads' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
