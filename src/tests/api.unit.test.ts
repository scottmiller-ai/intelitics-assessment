import { describe, expect, it } from 'vitest';

import {
  parseTopCustomersQuery,
  parseUsageWindow,
  requireAdmin,
  requireTenantIdentity,
  safeMetricNumber,
} from '../api/validation.js';
import { groupedRows } from '../queries/summarizeUsage.js';

const from = '2026-07-01T00:00:00Z';
const to = '2026-08-01T00:00:00+00:00';

describe('usage query validation', () => {
  it('accepts and normalizes two explicit bounds', () => {
    expect(parseUsageWindow({ from, to })).toMatchObject({
      fromIso: '2026-07-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
  });

  it('trims surrounding whitespace on explicit bounds', () => {
    expect(
      parseUsageWindow({
        from: ` ${from} `,
        to: ` ${to} `,
      }),
    ).toMatchObject({
      fromIso: '2026-07-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
  });

  it('captures now once for the default 30-day window', () => {
    expect(
      parseUsageWindow({}, new Date('2026-08-01T00:00:00Z')),
    ).toMatchObject({
      fromIso: '2026-07-02T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
  });

  it.each([
    { from },
    { from, to: from },
    { from: to, to: from },
    { from: '2025-01-01T00:00:00Z', to: '2026-08-01T00:00:00Z' },
    { from: '2026-07-01T00:00:00', to },
    { from, to, extra: 'x' },
  ])('rejects invalid window %#', (query) => {
    expect(() => parseUsageWindow(query)).toThrow();
  });

  it('accepts exactly a 366-day window', () => {
    expect(() =>
      parseUsageWindow({
        from: '2024-01-01T00:00:00Z',
        to: '2025-01-01T00:00:00Z',
      }),
    ).not.toThrow();
  });

  it.each(['0', '01', '101', '1.5', '-1', 'abc'])(
    'rejects limit %s',
    (limit) => {
      expect(() => parseTopCustomersQuery({ from, to, limit })).toThrow();
    },
  );

  it('defaults and caps the top-customer limit', () => {
    expect(parseTopCustomersQuery({ from, to }).limit).toBe(10);
    expect(parseTopCustomersQuery({ from, to, limit: '100' }).limit).toBe(100);
  });
});

describe('local auth adapters', () => {
  it('requires a matching tenant identity', () => {
    expect(() => requireTenantIdentity(undefined, 'cust_001')).toThrowError(
      expect.objectContaining({
        code: 'customer_identity_required',
        statusCode: 401,
      }),
    );
    expect(() => requireTenantIdentity('cust_002', 'cust_001')).toThrowError(
      expect.objectContaining({ code: 'tenant_mismatch', statusCode: 403 }),
    );
    expect(() => requireTenantIdentity('cust_001', 'cust_001')).not.toThrow();
    expect(() => requireTenantIdentity(['cust_001'], 'cust_001')).not.toThrow();
    expect(() =>
      requireTenantIdentity(['cust_001', 'cust_001'], 'cust_001'),
    ).toThrowError(expect.objectContaining({ name: 'RequestValidationError' }));
  });

  it('requires the exact admin stub value', () => {
    expect(() => requireAdmin('True')).toThrowError(
      expect.objectContaining({ code: 'admin_required', statusCode: 403 }),
    );
    expect(() => requireAdmin('true')).not.toThrow();
    expect(() => requireAdmin(['true'])).not.toThrow();
    expect(() => requireAdmin(['true', 'true'])).toThrowError(
      expect.objectContaining({ name: 'RequestValidationError' }),
    );
  });
});

describe('aggregate conversion and response shaping', () => {
  it('converts safe bigint values and rejects unsafe values', () => {
    expect(safeMetricNumber(42n)).toBe(42);
    expect(() =>
      safeMetricNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    ).toThrowError(expect.objectContaining({ code: 'aggregate_out_of_range' }));
  });

  it('preserves null buckets when naming grouped dimensions', () => {
    expect(
      groupedRows('status', [
        { value: 'success', event_count: 2, total_duration_ms: 10 },
        { value: null, event_count: 1, total_duration_ms: 0 },
      ]),
    ).toEqual([
      { status: 'success', event_count: 2, total_duration_ms: 10 },
      { status: null, event_count: 1, total_duration_ms: 0 },
    ]);
  });
});
