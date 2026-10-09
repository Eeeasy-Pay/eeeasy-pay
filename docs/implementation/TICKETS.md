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
  ✅ DONE 2026-10-09 by Vibe (PR #4, squash `4348e85`; verifying CI run `37864335884`).
- **TICKET-002 Contracts + OpenAPI.** Flesh out `packages/contracts` with full Zod (or
  equivalent) schemas for every V1 type and produce `apps/api/openapi/v1.yaml` covering
  `POST /v1/payment-intents`, `GET /v1/payment-intents/{id}`,
  `POST /v1/payment-intents/{id}/confirm`, status, and split routes, using the closed
  problem-code set. Acceptance: schema validation tests pass; OpenAPI lints; no route
  exposes scheme internals. ✅ DONE 2026-10-09 by Vibe (zod-first rewrite + v1.yaml; see
  ADR-013 and the squash-merge message for the verifying CI run).
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
  Update 2026-10-09: the repo-visibility step is superseded — the owner decided the
  repository stays public (revised ADR-002; B-09 resolved). Remaining: verified lockfile +
  `--frozen-lockfile` + TEST_EVIDENCE.md. Note: a `pnpm-lock.yaml` was auto-committed by
  the TICKET-001 CI guard; it still needs verification before enabling `--frozen-lockfile`.

## Operator workstream (PRD v1.2 rebaseline, D-08/D-09)

- **TICKET-009 Operator infra bootstrap (`infra/mojaloop/`).** Create the operator-owned
  central Hub deployment skeleton per the packet's Mojaloop module guide: README with the
  safe dev/test add/pull/verify/render/install/teardown procedure,
  `release/chart-artifact.lock.yaml` (project-owned manifest schema, values pending until
  a real pull), `values/dev-reference.yaml` (placeholder-safe; derive only from actually
  inspected v17.2.0 values), `scripts/` lint/render/evidence helpers that fail loudly and
  truthfully when Helm is missing, and an ignored `.artifacts/` area. Acceptance: CI green;
  no chart archive vendored; no secrets; no production claims; scripts honestly report
  missing tooling.
- **TICKET-010 Hub chart pull/render verification (BLOCKED on B-10 environment).** When a
  disposable cluster and Helm are available: `helm repo add mojaloop
  https://mojaloop.io/helm/repo/`, pull `mojaloop/mojaloop --version 17.2.0`, record
  SHA-256, lint, template with reviewed values, and fill the release manifest with the
  complete rendered workload/image/dependency inventory plus Helm/Kubernetes versions and
  compatibility caveats. Acceptance: real checksums and inventory committed as evidence;
  no compatibility claims beyond what was actually tested; disposable/synthetic test
  environment only.
- **TICKET-011 Synthetic account-link & alias flows.** Extend domain/ports/simulator for
  references to existing external bank/wallet accounts: account-link state machine
  (pending -> verified -> active, consent-gated), user-selected default send/receive
  accounts (step-up + audited changes, one active default per currency), and
  phone-alias / QR / shareable request-link previews (a preview is never authorization).
  Synthetic data only; no stored balance; nothing hard-coded from the Sudan/SDG
  assumption. Acceptance: tests cover default-account invariants, link eligibility at
  intent creation and confirmation, and preview-is-not-authorization.
