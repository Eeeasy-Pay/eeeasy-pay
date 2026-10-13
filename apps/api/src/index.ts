// Product HTTP API entrypoint (TICKET-003). Product routes only (GUARDRAILS.md #7): no
// scheme or partner endpoint is exposed through this package. SIMULATOR ONLY.
export { createApiApp } from './app.ts';
export type { ApiDeps } from './app.ts';
export { bearerSubject, UnauthenticatedError } from './auth.ts';
export {
  MemoryIdempotencyRepository,
  MemoryIntentStore,
  MemoryOutboxRepository,
  MemoryPaymentEventStore,
  MemoryQuoteStore,
  MemoryTransaction,
} from './memory.ts';
export type { IntentRecord, MemoryPaymentEventRecord, StoredQuote } from './memory.ts';
export { problem } from './problems.ts';
export type { ProblemInput } from './problems.ts';
export {
  applySimulatedSettlementStage,
  projectIntentState,
  readScenarioFacts,
} from './projector.ts';
export type {
  ProjectionChange,
  ProjectorDeps,
  ReconciliationFact,
  ScenarioFacts,
  SubmissionFact,
} from './projector.ts';
export { runScenario, SCENARIO_NAMES } from './scenarios.ts';
export type {
  ExternalSubmissionCall,
  ScenarioName,
  ScenarioOptions,
  ScenarioRunResult,
  ScenarioStep,
} from './scenarios.ts';
