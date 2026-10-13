// Inbox ingestor (TICKET-005). Authenticated provider events are deduplicated by
// (provider key, provider event id) + payload digest through the reviewed ingest path
// (app_private.ingest_provider_event). A redelivery with a CHANGED payload under the
// same event id raises InboxPayloadConflictError and is quarantined — never silently
// accepted and never overwritten (ADR-006, GUARDRAILS.md #5). This ingest step records
// and completes the event; business projection of provider events is scenario work
// (TICKET-006).

import type { InboxLifecycleRepository, InboxRepository } from '@eeeasy-pay/ports';
import { InboxPayloadConflictError } from '@eeeasy-pay/ports';
import { canonicalize, sha256Hex } from '@eeeasy-pay/pal';

/** Ingest plus lifecycle: the trusted worker's granted service_role paths. */
export type WorkerInboxStore = InboxRepository & InboxLifecycleRepository;

export interface InboxIngestDeps {
  readonly inbox: WorkerInboxStore;
}

export interface InboxIngestInput {
  readonly providerKey: string;
  readonly providerEventId: string;
  readonly schemaVersion: number;
  readonly paymentIntentId?: string;
  readonly correlationId?: string;
  readonly authenticatedPrincipal: string;
  /** Already-authenticated, normalized MINIMAL payload. No raw signed bodies (GUARDRAILS.md #5). */
  readonly normalizedPayload: Readonly<Record<string, unknown>>;
}

export type InboxIngestResult =
  | { readonly disposition: 'ingested'; readonly inboxEventId: string }
  | { readonly disposition: 'deduplicated'; readonly inboxEventId: string }
  | {
      readonly disposition: 'quarantined';
      readonly providerKey: string;
      readonly providerEventId: string;
    };

export class InboxIngestor {
  constructor(private readonly deps: InboxIngestDeps) {}

  async ingest(input: InboxIngestInput): Promise<InboxIngestResult> {
    const payloadDigest = sha256Hex(canonicalize(input.normalizedPayload));
    try {
      const stored = await this.deps.inbox.ingest({
        providerKey: input.providerKey,
        providerEventId: input.providerEventId,
        payloadDigest,
        schemaVersion: input.schemaVersion,
        ...(input.paymentIntentId !== undefined ? { paymentIntentId: input.paymentIntentId } : {}),
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        authenticatedPrincipal: input.authenticatedPrincipal,
        normalizedPayload: input.normalizedPayload,
      });
      if (stored.replayed) {
        return { disposition: 'deduplicated', inboxEventId: stored.inboxEventId };
      }
      await this.deps.inbox.markProcessed(stored.inboxEventId);
      return { disposition: 'ingested', inboxEventId: stored.inboxEventId };
    } catch (error) {
      if (error instanceof InboxPayloadConflictError) {
        await this.deps.inbox.quarantine(input.providerKey, input.providerEventId);
        return {
          disposition: 'quarantined',
          providerKey: input.providerKey,
          providerEventId: input.providerEventId,
        };
      }
      throw error;
    }
  }
}
