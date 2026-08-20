import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  normalizeEvent,
  type RejectionReason,
  rejectionHash,
} from '../ingest/normalizeEvent.js';

const valid = {
  customer_id: ' cust_001 ',
  event_type: ' Login ',
  endpoint: ' /v1/login ',
  user_email: ' User@Example.com ',
  plan: ' Pro ',
  occurred_at: '2026-07-14T18:32:11-04:00',
  metadata: {
    duration_ms: '214ms',
    status: ' Success ',
    nested: { b: 2, a: 1 },
  },
};

function rejection(raw: unknown): RejectionReason {
  const result = normalizeEvent(raw);
  if ('fact' in result) throw new Error('Expected rejection');
  return result.reason;
}

describe('normalizeEvent', () => {
  it('normalizes valid fields without changing case', () => {
    const result = normalizeEvent(valid);
    expect(result).toMatchObject({
      fact: {
        customerId: 'cust_001',
        eventType: 'Login',
        endpoint: '/v1/login',
        userEmail: 'User@Example.com',
        plan: 'Pro',
        occurredAt: '2026-07-14T22:32:11.000Z',
        durationMs: 214,
        status: 'Success',
        metadata: { nested: { b: 2, a: 1 } },
      },
    });
  });

  it.each([
    [null, 'invalid_record'],
    [{ ...valid, customer_id: undefined }, 'missing_customer_id'],
    [{ ...valid, customer_id: 7 }, 'invalid_customer_id'],
    [{ ...valid, customer_id: 'bad\u0000customer' }, 'invalid_customer_id'],
    [{ ...valid, event_type: ' ' }, 'missing_event_type'],
    [{ ...valid, event_type: false }, 'invalid_event_type'],
    [{ ...valid, occurred_at: null }, 'missing_occurred_at'],
    [{ ...valid, occurred_at: '07/14/2026 6:32pm' }, 'ambiguous_occurred_at'],
    [{ ...valid, occurred_at: '2026-02-30T12:00:00Z' }, 'invalid_occurred_at'],
    [{ ...valid, endpoint: '' }, 'invalid_endpoint'],
    [{ ...valid, user_email: 4 }, 'invalid_user_email'],
    [{ ...valid, plan: {} }, 'invalid_plan'],
    [{ ...valid, metadata: [] }, 'invalid_metadata'],
    [
      { ...valid, metadata: { nested: ['bad\u0000value'] } },
      'invalid_metadata',
    ],
    [{ ...valid, metadata: { duration_ms: '-1ms' } }, 'invalid_duration_ms'],
    [{ ...valid, metadata: { status: ' ' } }, 'invalid_status'],
  ] as const)('rejects malformed input as %s', (raw, reason) => {
    expect(rejection(raw)).toBe(reason);
  });

  it.each([0, 2_147_483_647, '0ms', '214ms'])(
    'accepts valid duration %s',
    (durationMs) => {
      expect(
        normalizeEvent({ ...valid, metadata: { duration_ms: durationMs } }),
      ).toHaveProperty(
        'fact.durationMs',
        typeof durationMs === 'string'
          ? Number.parseInt(durationMs, 10)
          : durationMs,
      );
    },
  );

  it.each([-1, 1.5, 2_147_483_648, '1', '1.5ms', '214MS'])(
    'rejects invalid duration %s',
    (durationMs) => {
      expect(
        rejection({ ...valid, metadata: { duration_ms: durationMs } }),
      ).toBe('invalid_duration_ms');
    },
  );

  it('accepts missing optionals as null and does not infer a tenant from email', () => {
    const result = normalizeEvent({
      event_type: 'login',
      occurred_at: '2026-07-01T00:00:00Z',
      user_email: 'person@known-domain.test',
    });
    expect(result).toEqual({ reject: true, reason: 'missing_customer_id' });

    const accepted = normalizeEvent({
      customer_id: 'cust_001',
      event_type: 'login',
      occurred_at: '2026-07-01T00:00:00Z',
    });
    expect(accepted).toMatchObject({
      fact: {
        endpoint: null,
        userEmail: null,
        plan: null,
        durationMs: null,
        status: null,
        metadata: {},
      },
    });
  });
});

describe('canonical hashes', () => {
  it('recursively sorts object keys and preserves array order', () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: [3, { y: 2, x: 1 }] } })).toBe(
      '{"a":{"b":[3,{"x":1,"y":2}],"d":4},"z":1}',
    );
  });

  it('produces stable event and rejection hashes', () => {
    const first = normalizeEvent(valid);
    const second = normalizeEvent({
      metadata: {
        nested: { a: 1, b: 2 },
        status: ' Success ',
        duration_ms: '214ms',
      },
      occurred_at: '2026-07-14T22:32:11Z',
      plan: ' Pro ',
      user_email: ' User@Example.com ',
      endpoint: ' /v1/login ',
      event_type: ' Login ',
      customer_id: ' cust_001 ',
    });
    expect(first).toHaveProperty('ingestHash');
    expect(second).toHaveProperty(
      'ingestHash',
      (first as { ingestHash: string }).ingestHash,
    );

    const input = {
      sourceContentSha256: 'a'.repeat(64),
      sourceIndex: 2,
      reason: 'invalid_record' as const,
      raw: null,
    };
    expect(rejectionHash(input)).toBe(rejectionHash({ ...input }));
  });
});

describe('fixture normalization', () => {
  it('matches the golden accepted, duplicate, and rejection profile', async () => {
    const rows = JSON.parse(
      await readFile(
        new URL('../../data/fixtures/usage_events.json', import.meta.url),
        'utf8',
      ),
    ) as unknown[];
    const hashes = new Set<string>();
    let accepted = 0;
    let duplicate = 0;
    const rejected: Record<string, number> = {};

    for (const row of rows) {
      const result = normalizeEvent(row);
      if ('reject' in result) {
        rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
      } else if (hashes.has(result.ingestHash)) {
        duplicate += 1;
      } else {
        hashes.add(result.ingestHash);
        accepted += 1;
      }
    }

    expect({ accepted, duplicate, rejected }).toEqual({
      accepted: 417,
      duplicate: 16,
      rejected: {
        ambiguous_occurred_at: 3,
        missing_customer_id: 3,
        missing_occurred_at: 3,
      },
    });
  });
});
