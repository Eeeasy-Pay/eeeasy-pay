import type {
  ConfirmPaymentIntentCommand,
  ConfirmPaymentIntentOutcome,
  PaymentCommandPort,
} from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { mapDbErrorAsync } from './errors.ts';
import { hexToBuffer } from './hex.ts';

/**
 * Quote-bound confirmation through app_private.confirm_payment_intent: idempotency
 * record, intent projection, append-only UserAuthorized event, and the durable
 * 'submit_payment' outbox command commit atomically (ADR-006, migration 202610060003).
 */
export class PostgresPaymentCommands implements PaymentCommandPort {
  constructor(private readonly db: Db) {}

  async confirmPaymentIntent(
    command: ConfirmPaymentIntentCommand,
  ): Promise<ConfirmPaymentIntentOutcome> {
    return mapDbErrorAsync(async () => {
      const result = await this.db.query<{ result: Record<string, unknown> }>(
        'SELECT app_private.confirm_payment_intent($1, $2, $3, $4, $5, $6, $7, $8) AS result',
        [
          command.actorId,
          command.paymentIntentId,
          command.quoteId,
          hexToBuffer(command.quoteBindingDigest),
          hexToBuffer(command.requestDigest),
          hexToBuffer(command.idempotencyKeyDigest),
          command.authorizationEvidenceRef,
          command.correlationId,
        ],
      );
      const value = result.rows[0]?.result;
      if (typeof value !== 'object' || value === null) {
        throw new Error('confirm_payment_intent did not return a result object');
      }
      const paymentIntentId = value['payment_intent_id'];
      const state = value['state'];
      return {
        replayed: value['replayed'] === true,
        paymentIntentId: typeof paymentIntentId === 'string' ? paymentIntentId : null,
        state: typeof state === 'string' ? state : String(state),
      };
    });
  }
}
