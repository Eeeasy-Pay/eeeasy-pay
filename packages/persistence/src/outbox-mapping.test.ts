import { describe, expect, it } from 'vitest';
import type { OutboxRow } from './outbox-repository.ts';
import { mapOutboxRow } from './outbox-repository.ts';
import { sha256Hex } from '@eeeasy-pay/pal';

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    outbox_message_id: '00000000-0000-4000-8000-000000000001',
    aggregate_type: 'payment_intent',
    aggregate_id: '00000000-0000-4000-8000-000000000002',
    command_type: 'submit_payment',
    schema_version: 1,
    idempotency_key_sha256: Buffer.from(sha256Hex('key'), 'hex'),
    payload_sha256: Buffer.from(sha256Hex('payload'), 'hex'),
    safe_payload: { payment_intent_id: '00000000-0000-4000-8000-000000000002' },
    state: 'leased',
    attempts: 1,
    available_at: new Date('2026-10-13T10:00:00.000Z'),
    lease_owner: 'worker-1',
    lease_token: '00000000-0000-4000-8000-000000000003',
    ...overrides,
  };
}

describe('mapOutboxRow', () => {
  it('maps digests to hex and timestamps to ISO strings', () => {
    const record = mapOutboxRow(row());
    expect(record.idempotencyKeyDigest).toBe(sha256Hex('key'));
    expect(record.payloadDigest).toBe(sha256Hex('payload'));
    expect(record.availableAt).toBe('2026-10-13T10:00:00.000Z');
    expect(record.state).toBe('leased');
    expect(record.attempts).toBe(1);
    expect(record.leaseOwner).toBe('worker-1');
    expect(record.leaseToken).toBe('00000000-0000-4000-8000-000000000003');
  });

  it('omits lease fields when the message is not leased', () => {
    const record = mapOutboxRow(row({ state: 'pending', lease_owner: null, lease_token: null }));
    expect(record).not.toHaveProperty('leaseOwner');
    expect(record).not.toHaveProperty('leaseToken');
    expect(record.state).toBe('pending');
  });
});
