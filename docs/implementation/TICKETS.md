# Implementation tickets (coding-agent workflow)

Workflow for every ticket:
1. Create a branch `ticket/TICKET-00N-slug` from `main`.
2. Implement only what the ticket says; do not refactor unrelated code; obey
   `GUARDRAILS.md`.
3. All CI jobs must pass (typecheck, unit tests, migrations+RLS, secret scan).
4. Open a PR describing what changed, commands run, and results. The supervising engineer
   reviews and merges. Do not push to `main` directly.

- **TICKET-001 Lint/format baseline.** Add ESLint + Prettier configs and scripts
  (`pnpm run lint`, `pnpm run format:check`) consistent with TypeScript strict mode; add to CI.
  Acceptance: lint and format checks pass in CI and locally; no behavioral code changes.
- **TICKET-002 Contracts + OpenAPI.** Flesh out `packages/contracts` with full Zod (or
  equivalent) schemas for every V1 type and produce `apps/api/openapi/v1.yaml` covering
  `POST /v1/payment-intents`, `GET /v1/payment-intents/{id}`,
  `POST /v1/payment-intents/{id}/confirm`, status, and split routes, using the closed
  problem-code set. Acceptance: schema validation tests pass; OpenAPI lints; no route
  exposes scheme internals.
- **TICKET-003 apps/api routes.** Implement the product HTTP API: auth'd payment-intent
  creation with server-scoped idempotency, read-only status projections with
  `quoteStatus`/`canConfirm`, confirm command returning `202`, problem+correlation
  responses, and route authorization tests. Acceptance: success, rejection, expiry,
  duplicate-replay, and key-conflict cases tested; no product state mutation in GET.
- **TICKET-004 packages/persistence.** Implement narrow Postgres repositories and
  transaction boundaries over the reviewed migrations: payment intents, quotes,
  idempotency, events, outbox claim/finish, inbox ingest, split claim. Acceptance:
  concurrency tests prove single durable outbox command per confirmation and no duplicate
  effects; RLS/grant paths tested for anon/authenticated/service roles.
- **TICKET-005 apps/worker.** Restart-safe outbox processor using lease-based claiming,
  simulator connector only, explicit `timeout_unknown` handling (query original external
  ID; never re-submit with a new ID), inbox dedupe + hash-conflict quarantine, crash/restart
  recovery tests.
- **TICKET-006 Simulator scenarios.** Deterministic end-to-end demo fixtures: success,
  rejection, expiry, duplicate request, ambiguous timeout followed by reconciliation; state
  labels distinguish `submitted`, `processing`, `unknown/needs reconciliation`,
  `recipient credited (simulated)`, settlement (simulated).
- **TICKET-007 Demo script.** Repeatable local demo (script or README walkthrough) with
  synthetic identities only; verifies the scenario set of TICKET-006 end to end.
- **TICKET-008 Hardening + evidence.** Commit a verified pnpm lockfile, enable
  `--frozen-lockfile`, add an issue/PR templates if useful, and record all executed
  commands and results in `docs/implementation/TEST_EVIDENCE.md`. Also: flip repository to
  private (B-09) and close D-05/ADR-002.
