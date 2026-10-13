// TICKET-004 acceptance: product journal. Balanced double entry only, atomic posting
// with idempotent replay of the same key, rejection of unbalanced or conflicting requests
// (migration 0003).

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  countRows,
  createHarness,
  databaseUrl,
  expectPgError,
  truncateAll,
  type Harness,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('journal persistence', () => {
  const h: Harness = createHarness(databaseUrl);

  beforeEach(async () => {
    await truncateAll(h);
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  it('posts a balanced journal and replays the same key to the same transaction', async () => {
    const lines = [
      { accountCode: 'PAYER_SIM_CLEARING', side: 'debit' as const, amountMinor: 1001n },
      { accountCode: 'SIM_INTERNAL_CLEARING', side: 'credit' as const, amountMinor: 1001n },
    ];
    const input = {
      currency: 'XTS',
      sourceSystem: 'pal',
      eventKind: 'sim_transfer_committed',
      idempotencyKeyDigest: sha256Hex('journal-key-1'),
      lines,
    };
    const first = await h.journal.postBalancedJournal(input);
    expect(first.replayed).toBe(false);
    const replay = await h.journal.postBalancedJournal(input);
    expect(replay.journalTransactionId).toBe(first.journalTransactionId);
    expect(replay.replayed).toBe(true);
    expect(await countRows(h, 'journal_transactions')).toBe(1);
    expect(await countRows(h, 'journal_entries')).toBe(2);
  });

  it('rejects an unbalanced journal and key reuse with different lines', async () => {
    await expectPgError(
      () =>
        h.journal.postBalancedJournal({
          currency: 'XTS',
          sourceSystem: 'pal',
          eventKind: 'sim_transfer_committed',
          idempotencyKeyDigest: sha256Hex('journal-key-unbalanced'),
          lines: [
            { accountCode: 'A', side: 'debit', amountMinor: 1000n },
            { accountCode: 'B', side: 'credit', amountMinor: 900n },
          ],
        }),
      '23514',
    );
    const balanced = [
      { accountCode: 'A', side: 'debit' as const, amountMinor: 1000n },
      { accountCode: 'B', side: 'credit' as const, amountMinor: 1000n },
    ];
    await h.journal.postBalancedJournal({
      currency: 'XTS',
      sourceSystem: 'pal',
      eventKind: 'sim_transfer_committed',
      idempotencyKeyDigest: sha256Hex('journal-key-conflict'),
      lines: balanced,
    });
    await expectPgError(
      () =>
        h.journal.postBalancedJournal({
          currency: 'XTS',
          sourceSystem: 'pal',
          eventKind: 'sim_transfer_committed',
          idempotencyKeyDigest: sha256Hex('journal-key-conflict'),
          lines: [
            { accountCode: 'C', side: 'debit', amountMinor: 2000n },
            { accountCode: 'D', side: 'credit', amountMinor: 2000n },
          ],
        }),
      '22023',
    );
    expect(await countRows(h, 'journal_transactions')).toBe(1);
  });
});
