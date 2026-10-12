// Product HTTP API entrypoint (TICKET-003). Product routes only (GUARDRAILS.md #7): no
// scheme or partner endpoint is exposed through this package. SIMULATOR ONLY.
export { createApiApp } from './app.ts';
export type { ApiDeps } from './app.ts';
export { bearerSubject, UnauthenticatedError } from './auth.ts';
export {
  MemoryIdempotencyRepository,
  MemoryIntentStore,
  MemoryOutboxRepository,
  MemoryQuoteStore,
  MemoryTransaction,
} from './memory.ts';
export type { IntentRecord, StoredQuote } from './memory.ts';
export { problem } from './problems.ts';
export type { ProblemInput } from './problems.ts';
