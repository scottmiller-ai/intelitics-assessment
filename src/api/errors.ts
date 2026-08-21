import type { FastifyInstance } from 'fastify';

import { CustomerNotFoundError } from '../db/tenantSession.js';
import { MetricRangeError } from '../queries/usage.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

function isSchemaValidationError(
  error: unknown,
): error is { code: string; message: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'FST_ERR_VALIDATION'
  );
}

/**
 * Domain and validation failures become stable codes here. Anything unmapped is
 * an internal error: it is logged with context and answered without one.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      void reply
        .status(error.status)
        .send({ error: error.code, details: error.message });
      return;
    }
    if (error instanceof CustomerNotFoundError) {
      void reply
        .status(404)
        .send({ error: 'customer_not_found', details: error.message });
      return;
    }
    if (error instanceof MetricRangeError) {
      request.log.error(
        { err: error },
        'Aggregate exceeded safe integer range',
      );
      void reply
        .status(500)
        .send({ error: 'aggregate_out_of_range', details: error.message });
      return;
    }
    if (isSchemaValidationError(error)) {
      void reply
        .status(400)
        .send({ error: 'invalid_request', details: error.message });
      return;
    }
    request.log.error({ err: error }, 'Request failed');
    void reply
      .status(500)
      .send({ error: 'internal_error', details: 'Unexpected failure' });
  });
}
