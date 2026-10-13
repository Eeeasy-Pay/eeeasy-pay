// Product journal repository over the reviewed post_balanced_journal function
// (migration 0003). The function is the ONLY granted write path and validates
// same-currency double entry atomically; replay of the same idempotency key returns
// the original journal transaction id.

import { hexToBuffer, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

export interface JournalLine {
  readonly accountCode: string;
  readonly side: 'debit' | 'credit';
  readonly amountMinor: bigint;
}

export interface PostJournalInput {
  readonly currency: string;
  readonly sourceSystem: string;
  readonly externalReference?: string;
  readonly eventKind: string;
  readonly idempotencyKeyDigest: string;
  readonly lines: readonly JournalLine[];
}

export class PostgresJournalRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  /**
   * Posts a balanced journal. Returns the journal transaction id and whether an
   * existing entry was replayed. Unbalanced lines or key reuse with a different
   * request are rejected by the database function.
   */
  async postBalancedJournal(input: PostJournalInput): Promise<{
    journalTransactionId: string;
    replayed: boolean;
  }> {
    const payload = input.lines.map((line) => ({
      account_code: line.accountCode,
      side: line.side,
      amount_minor: line.amountMinor.toString(),
    }));
    const db = this.db;
    const existing = await db<{ journal_transaction_id: string }[]>`
      SELECT journal_transaction_id FROM public.journal_transactions
      WHERE source_system = ${input.sourceSystem}
        AND idempotency_key_sha256 = ${hexToBuffer(input.idempotencyKeyDigest)}`;
    const rows = await db<{ id: string }[]>`
      SELECT app_private.post_balanced_journal(
        ${input.currency}, ${input.sourceSystem}, ${input.externalReference ?? null},
        ${input.eventKind}, ${hexToBuffer(input.idempotencyKeyDigest)},
        ${JSON.stringify(payload)}::jsonb) AS id`;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error('post_balanced_journal returned no id');
    }
    return { journalTransactionId: id, replayed: existing.length > 0 };
  }
}
