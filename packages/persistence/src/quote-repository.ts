import type { QuoteInsert, QuoteRecord, QuoteRepository } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { bufferToHex, hexToBuffer } from './hex.ts';

const SELECT_COLUMNS =
  'quote_id, payment_intent_id, provider_key, partner_quote_ref, api_profile, currency, ' +
  'requested_amount_minor, quoted_fee_minor, payer_debit_minor, recipient_amount_minor, ' +
  'fee_rule_version, binding_hash, issued_at, expires_at';

interface QuoteRow {
  quote_id: string;
  payment_intent_id: string;
  provider_key: string;
  partner_quote_ref: string;
  api_profile: string;
  currency: string;
  requested_amount_minor: string;
  quoted_fee_minor: string;
  payer_debit_minor: string;
  recipient_amount_minor: string;
  fee_rule_version: string;
  binding_hash: Buffer;
  issued_at: Date;
  expires_at: Date;
}

export class PostgresQuoteRepository implements QuoteRepository {
  constructor(private readonly db: Db) {}

  async insertQuote(quote: QuoteInsert): Promise<void> {
    await this.db.query(
      `INSERT INTO public.payment_quotes
         (quote_id, payment_intent_id, provider_key, partner_quote_ref, api_profile,
          currency, requested_amount_minor, quoted_fee_minor, payer_debit_minor,
          recipient_amount_minor, fee_rule_version, request_fingerprint, binding_hash,
          issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        quote.quoteId,
        quote.paymentIntentId,
        quote.providerKey,
        quote.partnerQuoteRef,
        quote.apiProfile,
        quote.currency,
        String(quote.requestedAmountMinor),
        String(quote.quotedFeeMinor),
        String(quote.payerDebitMinor),
        String(quote.recipientAmountMinor),
        quote.feeRuleVersion,
        hexToBuffer(quote.requestFingerprintDigest),
        hexToBuffer(quote.bindingDigest),
        quote.issuedAt,
        quote.expiresAt,
      ],
    );
  }

  async findQuoteById(quoteId: string): Promise<QuoteRecord | null> {
    const result = await this.db.query<QuoteRow>(
      `SELECT ${SELECT_COLUMNS} FROM public.payment_quotes WHERE quote_id = $1`,
      [quoteId],
    );
    const row = result.rows[0];
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
      requestedAmountMinor: BigInt(row.requested_amount_minor),
      quotedFeeMinor: BigInt(row.quoted_fee_minor),
      payerDebitMinor: BigInt(row.payer_debit_minor),
      recipientAmountMinor: BigInt(row.recipient_amount_minor),
      feeRuleVersion: row.fee_rule_version,
      bindingDigest: bufferToHex(row.binding_hash),
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
}
