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

interface SchemaViolation {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

interface SchemaValidationError {
  validation: SchemaViolation[];
  validationContext?: string;
}

function isSchemaValidationError(
  error: unknown,
): error is Error & SchemaValidationError {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'FST_ERR_VALIDATION' &&
    'validation' in error &&
    Array.isArray(error.validation)
  );
}

function named(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Fastify names the request part after its schema key. Callers say it plainly. */
const partNames: Record<string, string> = {
  querystring: 'query',
  params: 'path',
  headers: 'header',
};

/**
 * Ajv's own wording is readable but it belongs to Ajv: upgrading the validator
 * would silently reword a public field. `details` is ours, so it is written
 * here from the machine-readable parts of the failure.
 */
export function describeViolation(error: SchemaValidationError): string {
  const context = error.validationContext ?? '';
  const part = partNames[context] ?? 'request';
  const [violation] = error.validation;
  if (!violation) return `Invalid ${part}`;

  const field =
    violation.instancePath.replace(/^\//, '') ||
    named(violation.params.missingProperty);

  switch (violation.keyword) {
    case 'additionalProperties':
      return `Unknown ${part} parameter: ${
        named(violation.params.additionalProperty) ?? 'unknown'
      }`;
    case 'dependencies':
      return 'from and to must be sent together';
    case 'required':
      return `Missing required ${part} parameter: ${field ?? 'unknown'}`;
    default:
      return field
        ? `Invalid value for ${part} parameter: ${field}`
        : `Invalid ${part}`;
  }
}

/**
 * Domain and validation failures become stable codes here. Anything unmapped is
 * an internal error: it is logged with context and answered without one.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  // Without this, an unrouted path falls through to Fastify's default body,
  // where `error` is the reason phrase "Not Found" rather than a code. A client
  // switching on `error` would need two vocabularies, one of them prose.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: 'not_found',
      details: `No route for ${request.method} ${request.url.split('?')[0] ?? request.url}`,
    });
  });

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
        .send({ error: 'invalid_request', details: describeViolation(error) });
      return;
    }
    request.log.error({ err: error }, 'Request failed');
    void reply
      .status(500)
      .send({ error: 'internal_error', details: 'Unexpected failure' });
  });
}
