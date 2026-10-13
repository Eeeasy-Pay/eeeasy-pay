import { PaymentStateConflictError } from '@eeeasy-pay/ports';
import type { PaymentIntentRecord, PaymentIntentRepository, PaymentState } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';

export interface PaymentIntentCreateInput {
  readonly paymentIntentId: string;
  readonly actorId: string;
  readonly sourceBankLinkId: string;
  readonly recipientAliasId: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
}

export interface PaymentIntentWriter {
  create(input: PaymentIntentCreateInput): Promise<void>;
  /** Binds the quote and moves the intent to 'quoted'. Legal only while no quote is bound. */
  attachQuote(paymentIntentId: string, quoteId: string): Promise<void>;
}

const SELECT_COLUMNS =
  'payment_intent_id, user_id, payment_state, currency, requested_amount_minor, current_quote_id';

interface IntentRow {
  payment_intent_id: string;
  user_id: string;
  payment_state: PaymentState;
  currency: string;
  requested_amount_minor: string;
  current_quote_id: string | null;
}

function toRecord(row: IntentRow): PaymentIntentRecord {
  return {
    paymentIntentId: row.payment_intent_id,
    actorId: row.user_id,
    state: row.payment_state,
    currency: row.currency,
    requestedAmountMinor: BigInt(row.requested_amount_minor),
    ...(row.current_quote_id !== null ? { currentQuoteId: row.current_quote_id } : {}),
  };
}

export class PostgresPaymentIntentRepository implements PaymentIntentRepository, PaymentIntentWriter {
  constructor(private readonly db: Db) {}

  async findById(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const result = await this.db.query<IntentRow>(
      `SELECT ${SELECT_COLUMNS} FROM public.payment_intents WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Ownership-scoped lookup doubles as enumeration resistance: another actor's intent is
   * indistinguishable from a missing one (same null, no row is read).
   */
  async findOwnedById(paymentIntentId: string, actorId: string): Promise<PaymentIntentRecord | null> {
    const result = await this.db.query<IntentRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM public.payment_intents
        WHERE payment_intent_id = $1 AND user_id = $2`,
      [paymentIntentId, actorId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async create(input: PaymentIntentCreateInput): Promise<void> {
    // Route eligibility (active bank link for actor+currency, active alias projection) is
    // enforced by the app_private.validate_payment_route trigger on insert.
    await this.db.query(
      `INSERT INTO public.payment_intents
         (payment_intent_id, user_id, source_bank_link_id, recipient_alias_id,
          currency, requested_amount_minor, payment_state)
       VALUES ($1, $2, $3, $4, $5, $6, 'created')`,
      [
        input.paymentIntentId,
        input.actorId,
        input.sourceBankLinkId,
        input.recipientAliasId,
        input.currency,
        String(input.requestedAmountMinor),
      ],
    );
  }

  async attachQuote(paymentIntentId: string, quoteId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE public.payment_intents
          SET payment_state = 'quoted', current_quote_id = $2
        WHERE payment_intent_id = $1
          AND payment_state IN ('created', 'quoting')
          AND current_quote_id IS NULL`,
      [paymentIntentId, quoteId],
    );
    if (result.rowCount !== 1) {
      throw new PaymentStateConflictError();
    }
  }
}
