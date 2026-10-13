// Payment-intent repository over the reviewed migrations (0002 + 0004 + 0005).
//
// All writes go through the table triggers and the SECURITY DEFINER command function
// confirm_payment_intent (migration 0003), which locks the intent row, re-verifies
// actor, quote binding, expiry, state and route eligibility, and commits the
// idempotency record + authorized projection + append-only event + outbox command
// in ONE transaction (ADR-006). Nothing here bypasses RLS/grants (GUARDRAILS.md #5).

import { quoteTotals, type PaymentState } from '@eeeasy-pay/domain';
import type { PaymentIntentRecord, PaymentIntentRepository } from '@eeeasy-pay/ports';
import { canonicalize, sha256Hex } from '@eeeasy-pay/pal';
import { hexToBuffer, toHex, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

interface IntentRow {
  payment_intent_id: string;
  user_id: string;
  payment_state: PaymentState;
  currency: string;
  requested_amount_minor: bigint;
  current_quote_id: string | null;
}

export interface QuoteTermsInput {
  readonly quoteId: string;
  readonly providerKey: string;
  readonly partnerQuoteRef: string;
  readonly apiProfile: string;
  readonly quotedFeeMinor: bigint;
  readonly feeRuleVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Digest over the canonical quote terms (pal.quoteBindingSha256). */
  readonly bindingDigest: string;
  /** Digest over the canonical quote request (server-scoped fingerprint). */
  readonly requestDigest: string;
}

export interface CreateIntentWithQuoteInput {
  readonly paymentIntentId: string;
  readonly actorId: string;
  readonly sourceBankLinkId: string;
  readonly recipientAliasId: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly quote: QuoteTermsInput;
  readonly correlationId: string;
}

export interface StoredQuote {
  readonly quoteId: string;
  readonly paymentIntentId: string;
  readonly providerKey: string;
  readonly partnerQuoteRef: string;
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly quotedFeeMinor: bigint;
  readonly payerDebitMinor: bigint;
  readonly recipientAmountMinor: bigint;
  readonly feeRuleVersion: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly requestFingerprintDigest: string;
  readonly bindingDigest: string;
}

export interface ConfirmIntentInput {
  readonly actorId: string;
  readonly paymentIntentId: string;
  readonly quoteId: string;
  readonly bindingDigest: string;
  readonly requestDigest: string;
  readonly idempotencyKeyDigest: string;
  readonly authorizationEvidenceRef: string;
  readonly correlationId: string;
}

export interface ConfirmIntentResult {
  readonly paymentIntentId: string;
  readonly state: string;
  readonly replayed: boolean;
}

export interface PaymentEventInput {
  readonly paymentIntentId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly sourceSystem: string;
  readonly correlationId: string;
  readonly previousState?: PaymentState;
  readonly nextState?: PaymentState;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly privacyClass: 'operational_minimal' | 'sensitive_reference';
}

interface QuoteRow {
  quote_id: string;
  payment_intent_id: string;
  provider_key: string;
  partner_quote_ref: string;
  api_profile: string;
  currency: string;
  requested_amount_minor: bigint;
  quoted_fee_minor: bigint;
  payer_debit_minor: bigint;
  recipient_amount_minor: bigint;
  fee_rule_version: string;
  issued_at: Date;
  expires_at: Date;
  request_fingerprint: Buffer;
  binding_hash: Buffer;
}

function toIntentRecord(row: IntentRow): PaymentIntentRecord {
  return {
    paymentIntentId: row.payment_intent_id,
    actorId: row.user_id,
    state: row.payment_state,
    currency: row.currency,
    requestedAmountMinor: row.requested_amount_minor,
    ...(row.current_quote_id !== null ? { currentQuoteId: row.current_quote_id } : {}),
  };
}

export class PostgresPaymentIntentRepository implements PaymentIntentRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  async findById(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const rows = await this.selectIntent(paymentIntentId);
    const row = rows[0];
    return row ? toIntentRecord(row) : null;
  }

  async findOwnedById(
    paymentIntentId: string,
    actorId: string,
  ): Promise<PaymentIntentRecord | null> {
    const rows = await this.db<IntentRow[]>`
      SELECT payment_intent_id, user_id, payment_state, currency, requested_amount_minor, current_quote_id
      FROM public.payment_intents
      WHERE payment_intent_id = ${paymentIntentId}::uuid AND user_id = ${actorId}::uuid`;
    const row = rows[0];
    return row ? toIntentRecord(row) : null;
  }

  /**
   * Creates the intent, binds the quote and records the transition to 'quoted' in one
   * transaction. Quote totals are the deterministic domain ones (payer debit =
   * requested + fee, recipient receives the requested amount; no FX is invented).
   */
  async createIntentWithQuote(input: CreateIntentWithQuoteInput): Promise<PaymentIntentRecord> {
    const totals = quoteTotals(
      input.currency,
      input.requestedAmountMinor,
      input.quote.quotedFeeMinor,
    );
    return this.tx.run(async () => {
      const db = this.db;
      await db`
        INSERT INTO public.payment_intents
          (payment_intent_id, user_id, source_bank_link_id, recipient_alias_id, currency,
           requested_amount_minor, quoted_fee_minor, payer_debit_minor, recipient_amount_minor,
           payment_state)
        VALUES (${input.paymentIntentId}::uuid, ${input.actorId}::uuid, ${input.sourceBankLinkId}::uuid,
          ${input.recipientAliasId}::uuid, ${input.currency},
          ${input.requestedAmountMinor}, ${totals.quotedFeeMinor}, ${totals.payerDebitMinor},
          ${totals.recipientAmountMinor}, 'created')`;
      await this.recordEvent({
        paymentIntentId: input.paymentIntentId,
        eventType: 'PaymentIntentCreated',
        schemaVersion: 1,
        sourceSystem: 'pal',
        correlationId: input.correlationId,
        nextState: 'created',
        payload: { payment_intent_id: input.paymentIntentId },
        privacyClass: 'operational_minimal',
      });
      await db`
        INSERT INTO public.payment_quotes
          (quote_id, payment_intent_id, provider_key, partner_quote_ref, api_profile, currency,
           requested_amount_minor, quoted_fee_minor, payer_debit_minor, recipient_amount_minor,
           fee_rule_version, request_fingerprint, binding_hash, issued_at, expires_at)
        VALUES (${input.quote.quoteId}::uuid, ${input.paymentIntentId}::uuid, ${input.quote.providerKey},
          ${input.quote.partnerQuoteRef}, ${input.quote.apiProfile}, ${input.currency},
          ${input.requestedAmountMinor}, ${totals.quotedFeeMinor}, ${totals.payerDebitMinor},
          ${totals.recipientAmountMinor}, ${input.quote.feeRuleVersion},
          ${hexToBuffer(input.quote.requestDigest)}, ${hexToBuffer(input.quote.bindingDigest)},
          ${input.quote.issuedAt}::timestamptz, ${input.quote.expiresAt}::timestamptz)`;
      await db`
        UPDATE public.payment_intents
        SET payment_state = 'quoting'
        WHERE payment_intent_id = ${input.paymentIntentId}::uuid`;
      await db`
        UPDATE public.payment_intents
        SET payment_state = 'quoted', current_quote_id = ${input.quote.quoteId}::uuid
        WHERE payment_intent_id = ${input.paymentIntentId}::uuid`;
      await this.recordEvent({
        paymentIntentId: input.paymentIntentId,
        eventType: 'QuoteBound',
        schemaVersion: 1,
        sourceSystem: 'pal',
        correlationId: input.correlationId,
        previousState: 'quoting',
        nextState: 'quoted',
        payload: { payment_intent_id: input.paymentIntentId, quote_id: input.quote.quoteId },
        privacyClass: 'operational_minimal',
      });
      const record = await this.findOwnedById(input.paymentIntentId, input.actorId);
      if (!record) {
        throw new Error('createIntentWithQuote: intent disappeared after insert');
      }
      return record;
    });
  }

  /** Quote-bound confirmation via the reviewed atomic command function (ADR-006). */
  async confirmPaymentIntent(input: ConfirmIntentInput): Promise<ConfirmIntentResult> {
    const rows = await this.db<{ result: Record<string, unknown> }[]>`
      SELECT app_private.confirm_payment_intent(
        ${input.actorId}::uuid, ${input.paymentIntentId}::uuid, ${input.quoteId}::uuid,
        ${hexToBuffer(input.bindingDigest)}, ${hexToBuffer(input.requestDigest)},
        ${hexToBuffer(input.idempotencyKeyDigest)}, ${input.authorizationEvidenceRef},
        ${input.correlationId}::uuid) AS result`;
    const result = rows[0]?.result;
    if (
      !result ||
      typeof result.payment_intent_id !== 'string' ||
      typeof result.state !== 'string'
    ) {
      throw new Error('confirm_payment_intent returned an unexpected envelope');
    }
    return {
      paymentIntentId: result.payment_intent_id,
      state: result.state,
      replayed: result.replayed === true,
    };
  }

  async findCurrentQuote(paymentIntentId: string): Promise<StoredQuote | null> {
    const rows = await this.db<QuoteRow[]>`
      SELECT q.quote_id, q.payment_intent_id, q.provider_key, q.partner_quote_ref, q.api_profile,
             q.currency, q.requested_amount_minor, q.quoted_fee_minor, q.payer_debit_minor,
             q.recipient_amount_minor, q.fee_rule_version, q.issued_at, q.expires_at,
             q.request_fingerprint, q.binding_hash
      FROM public.payment_quotes q
      JOIN public.payment_intents p ON p.current_quote_id = q.quote_id
      WHERE p.payment_intent_id = ${paymentIntentId}::uuid`;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      quoteId: row.quote_id,
      paymentIntentId: row.payment_intent_id,
      providerKey: row.provider_key,
      partnerQuoteRef: row.partner_quote_ref,
      apiProfile: row.api_profile,
      currency: row.currency,
      requestedAmountMinor: row.requested_amount_minor,
      quotedFeeMinor: row.quoted_fee_minor,
      payerDebitMinor: row.payer_debit_minor,
      recipientAmountMinor: row.recipient_amount_minor,
      feeRuleVersion: row.fee_rule_version,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      requestFingerprintDigest: toHex(row.request_fingerprint),
      bindingDigest: toHex(row.binding_hash),
    };
  }

  /** Append-only event insert. Never updated, never deleted (GUARDRAILS.md #6). */
  async recordEvent(event: PaymentEventInput): Promise<string> {
    const rows = await this.db<{ payment_event_id: string }[]>`
      INSERT INTO public.payment_events
        (payment_intent_id, event_type, schema_version, source_system, correlation_id,
         previous_payment_state, next_payment_state, payload_sha256, privacy_class, safe_metadata)
      VALUES (${event.paymentIntentId}::uuid, ${event.eventType}, ${event.schemaVersion},
        ${event.sourceSystem}, ${event.correlationId}::uuid,
        ${event.previousState ?? null}::public.payment_state,
        ${event.nextState ?? null}::public.payment_state,
        ${hexToBuffer(sha256Hex(canonicalize(event.payload)))},
        ${event.privacyClass}, ${event.payload}::jsonb)
      RETURNING payment_event_id`;
    const id = rows[0]?.payment_event_id;
    if (!id) {
      throw new Error('recordEvent: insert returned no id');
    }
    return id;
  }
}
