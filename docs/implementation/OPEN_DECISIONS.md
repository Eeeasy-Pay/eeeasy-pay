# Open decisions and blockers

## Blockers (prevent partner integration / real-money use)

- **B-01 Sponsor DFSP contract unknown.** Under the rebaselined model (D-08) the
  sponsoring/licensed DFSP provides sponsorship and national-switch access and is
  intended to carry settlement and risk accountability under the arranged model. No
  signed scheme/partner profile exists: no endpoint, transport, signature/JWS or mTLS
  profile, callback schema, exact FSPIOP resource version, fee schedule, currency set,
  alias policy, account-link flow, or latency commitment. Everything partner-specific
  stays behind `packages/ports` + simulator until this exists.
- **B-02 No live scheme integration; Hub chart never rendered.** No live Mojaloop / SDK
  Scheme Adapter integration. The organization is the intended technical Scheme/Hub
  Operator (D-08); the first operator workstream stages the official `mojaloop/mojaloop`
  umbrella chart under `infra/mojaloop/` (D-09, TICKET-009/010). Mojaloop Helm chart
  v17.2.0 remains a test/reproducibility reference only. It has NOT been rendered or
  verified in this repository (no local Helm/cluster available — see B-10); do not
  claim a verified component set.
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
  fee schedule. Sudan/SDG is the dated simulator default configuration assumption (D-08),
  never a hard-coded currency fact.
- **B-09 Repository visibility -- RESOLVED 2026-10-09: stays public (owner decision).**
  The owner decided the repository remains public (ADR-012, superseding ADR-002/D-05).
  Requirements while public: no secrets or live credentials are ever committed (the CI
  secret-scan step enforces this), all partner/live integration stays simulated behind
  `packages/ports`, `main` should be protected (PR + green CI required to merge), no
  personal data in commits, and visibility is re-evaluated before any live-partner or
  production work.
- **B-10 No disposable Kubernetes/Helm environment.** No Helm CLI, kubectl, or isolated
  test cluster is available in the current tooling. The umbrella chart cannot be pulled,
  linted, rendered, or test-installed here. Report this truthfully; never claim a render
  or deployment. Choosing a cloud provider / cluster for the disposable test Hub is an
  ADR-gated owner decision.

## Decisions

- **D-01 Fresh repository.** No pre-existing codebase; a fresh Turborepo/pnpm monorepo was
  created rather than adopting an unrelated structure.
- **D-02 Exact minor-unit bigint money** in `packages/domain`; no floats anywhere in
  money paths.
- **D-03 Toolchain pins verified by the first fully green CI run** (PR #1, Actions run
  `37836984589`, 2026-10-08): Node 22 (`.nvmrc`), pnpm 10.12.1 (`packageManager`),
  turbo ^2.5.0, vitest ^3.2.0, TypeScript ^5.8.0. Both jobs green: `build-test`
  (install, typecheck, unit tests, build, secret scan) and `migrations` (auth fixture,
  six migrations in order, smoke assertions, all RLS/grant probes) on Postgres 16.
  Install still uses `pnpm install --no-frozen-lockfile` until a lockfile is committed
  (TICKET-008). Future pin changes again require a green run as evidence (ADR-003).
- **D-04 Quote expiry enforced at command time only** (see migration 0003
  `confirm_payment_intent` and 0005 command-time checks). Read-only status projections may
  report expiry. No DB timer trigger, duplicate column, enum, or timer worker.
- **D-05 Repository visibility: public (owner decision 2026-10-09).** Supersedes the
  earlier private decision (ADR-002). Recorded as ADR-012; B-09 resolved.
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
- **D-08 Operating-model rebaseline — dated working assumptions (9 October 2026,
  owner-provided; NOT verified legal, regulatory, or market facts).** The organization is
  the intended technical Scheme/Hub Operator and will own, deploy, and operate the
  complete central Mojaloop Hub infrastructure. The sponsoring/licensed DFSP supplies
  sponsorship and national-switch access and retains settlement and risk accountability
  under the intended arrangement; a settlement partner executes external
  settlement-account movement and acknowledgements. The P2P/A2A app is a scheme product,
  not the Hub. Working assumptions for design/build: the sponsoring bank's
  license/sponsorship covers the currently scoped app features; Sudan/SDG is the initial
  market/currency and the simulator default (configuration-controlled, never hard-coded).
  Formal operator designation, sponsor/scheme agreements, jurisdiction-specific legal
  validation, the exact app route (Mojaloop Third Party API/PISP vs the sponsor's
  approved channel — packet decision D-15), and participant contracts remain
  pre-production/live-launch gates. They do NOT block simulator, domain, API, UI,
  non-production IaC, or adapter-boundary work. No live credentials, live bank/switch
  integration, real-money activity, or public launch is authorized by these assumptions.
  Source: PRD v1.2 packet dated 9 October 2026 (owner-uploaded to the project library).
- **D-09 Chart-first central Hub deployment unit.** The deployable central Hub unit is
  the official `mojaloop/mojaloop` umbrella Helm chart — never five service repositories
  cloned or vendored into the monorepo. Chart references, non-secret values,
  release-evidence helpers, and operator IaC live under `infra/mojaloop/`; product code
  stays in `apps/`/`packages/`; the DFSP SDK Scheme Adapter / core connector stays in the
  DFSP trust zone and is never deployed centrally (the central ML-API-Adapter is a
  different Hub-side component). v17.2.0 is a test/reproducibility reference only:
  chart, subchart, and image versions are independently versioned and must be pinned
  separately in the project-owned release manifest
  (`infra/mojaloop/release/chart-artifact.lock.yaml` — not Helm's Chart.lock). The
  Third Party overlay (`thirdparty.enabled` plus the two ALS extended-PartyIdType flags)
  is conditional, off by default, and only for an isolated synthetic PISP-path trial.
  `example-mojaloop-backend` and inline dependency manifests are PoC/dev/test only,
  never production guidance. Every Helm command must name a chart; if Helm is missing,
  say so and do not claim a render (B-10).
