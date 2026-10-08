# Open decisions and blockers

## Blockers (prevent partner integration / real-money use)

- **B-01 Sponsor DFSP contract unknown.** No signed scheme/partner profile exists: no
  endpoint, transport, signature/JWS or mTLS profile, callback schema, exact FSPIOP resource
  version, fee schedule, currency set, alias policy, account-link flow, or latency
  commitment. Everything partner-specific stays behind `packages/ports` +
  simulator until this exists.
- **B-02 No live scheme integration.** No live Mojaloop / SDK Scheme Adapter integration.
  Mojaloop Helm chart v17.2.0 is a test/reproducibility reference only. It has NOT been
  rendered or verified in this repository (no local Helm was available); do not claim a
  verified component set.
- **B-03 Refunds deferred.** Authority, evidence, accounting, timing, and error behavior are
  undefined until the partner flow and decision D-12 exist. No refund code.
- **B-04 Contact discovery off.** Address-book upload and discovery are out of scope. No
  HMAC / OPRF-PSI / retention / migration selection has been made.
- **B-05 No real notification provider.** `NotificationPort` has only a simulator
  implementation. No real SMS/push sending.
- **B-06 No production onboarding.** No KYC, real bank account linking, alias registration,
  or production accounts of any kind.
- **B-07 Partner settlement evidence format unknown.** Settlement remains
  `not_applicable` in the simulator; the reconciliation mapping needs the partner contract.
- **B-08 Currency/fee placeholders.** Currency codes and simulator fees are placeholders
  pending the partner profile; the fee sanity bound in `packages/domain` is a guard, not a
  fee schedule.
- **B-09 Repository visibility.** The repository is currently **public**. Decision D-05 is
  private. Owner must flip it to private (Settings -> General -> Danger Zone -> Change
  visibility) before any further material lands.

## Decisions

- **D-01 Fresh repository.** No pre-existing codebase; a fresh Turborepo/pnpm monorepo was
  created rather than adopting an unrelated structure.
- **D-02 Exact minor-unit bigint money** in `packages/domain`; no floats anywhere in
  money paths.
- **D-03 Toolchain pins are CI-proposed, not yet verified:** Node 22 (`.nvmrc`),
  pnpm 10.12.1 (`packageManager`), turbo ^2.5.0, vitest ^3.2.0, TypeScript ^5.8.0,
  @types/node ^22.15.0. They become "verified" only after the first green CI run (ADR-003).
- **D-04 Quote expiry enforced at command time only** (see migration 0003
  `confirm_payment_intent` and 0005 command-time checks). Read-only status projections may
  report expiry. No DB timer trigger, duplicate column, enum, or timer worker.
- **D-05 Repository visibility: private.** Decided in ADR-002 (revised from an earlier
  public-repo idea). Current state is public; action pending (B-09).
- **D-06 Coding-agent workflow.** Tickets in `TICKETS.md` are implemented by the supervised
  coding agent via PRs; CI is the objective gate; the supervising engineer reviews PRs.
  No direct pushes to `main` by the agent.

- **D-07 Defect in reviewed migration 0003, fixed forward-only in 0006.**
  `app_private.claim_outbox` placed `FOR UPDATE SKIP LOCKED` before `LIMIT` inside its
  picking CTE. PostgreSQL requires `LIMIT` first, and plpgsql compiles bodies lazily,
  so every migration applied cleanly and the defect only surfaced when CI smoke first
  EXECUTED the function. Fixed by migration `202610060006` (CREATE OR REPLACE, no schema
  change, grants restated identically) per ADR-009. Reviewed migrations 0001-0005 remain
  byte-exact to the reviewed source. Consequence: reviewed SQL must be executed, not just
  read, before any of it is trusted; CI now exercises the reviewed functions.
