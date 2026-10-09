# Decision record (ADRs)

- **ADR-001 Monorepo structure.** Fresh repository with Turborepo/pnpm: `apps/api`,
  `apps/worker`, `packages/{domain,contracts,ports,pal,persistence,sponsor-dfsp-connector}`,
  `supabase/migrations`, `ci/`, `docs/implementation`. Deployables stay independently
  buildable.
- **ADR-002 Private repository.** The repository must be private (pre-launch fintech work).
  Revised from an initially proposed public repo. **SUPERSEDED 2026-10-09 by ADR-012:** the
  owner decided the repository remains public. Retained as history.
- **ADR-003 Toolchain pins.** Node 22, pnpm 10.12.1, turbo ^2.5.0, vitest ^3.2.0,
  TypeScript ^5.8.0. CI installs with `pnpm install --no-frozen-lockfile` until a lockfile is
  committed (TICKET-008). VERIFIED 2026-10-08 by the first fully green CI run
  (PR #1 / Actions run `37836984589`): build-test and migrations jobs both passed.
  No silent upgrades; future pin changes again require a green run as evidence.
- **ADR-004 Money is exact integer minor units (bigint).** `packages/domain/money.ts`
  enforces positive-only principal, non-negative fees, currency-consistent arithmetic, an
  overflow headroom bound, and a fee sanity bound. Never binary floating point.
- **ADR-005 Server-scoped idempotency.** A client key is an untrusted correlation input.
  The server fingerprint = SHA-256 over (actor, operation, canonicalized request). Same key +
  same fingerprint -> replay prior result; same key + different fingerprint -> conflict
  (`idempotency_conflict`). Mirrored by the DB unique key on (actor, operation, key digest).
- **ADR-006 Transactional command boundaries with outbox/inbox.** Authorization outcome,
  append-only event, idempotency record, and outbox command commit in one DB transaction.
  Workers process only durable commands; ambiguous external outcomes are modeled explicitly
  (`timeout_unknown`) and reconciled by querying the ORIGINAL external ID. Callback
  dedupe uses (provider key, provider event id) + payload digest; a changed payload under the
  same event id is quarantined/rejected.
- **ADR-007 Quote expiry at command time, projection-only in reads.** No time-based DB
  trigger, duplicate expiry column, enum, or timer worker. `packages/pal/expiry.ts` projects
  `quoteStatus`/`canConfirm` for reads without mutating rows; the confirm command re-checks
  expiry inside its transaction (migration 0003).
- **ADR-008 Typed sponsor boundary with simulator.** `packages/ports` defines the
  product-owned `SponsorDfspPort` with explicit outcome/evidence types. The only
  implementation is the deterministic simulator in `packages/sponsor-dfsp-connector`.
  The real adapter is a named TODO blocked on B-01. No FSPIOP signing, JWS/mTLS, or partner
  claims of any kind.

- **ADR-009 Forward-only function-body fix migration.** CI execution proved reviewed
  migration 0003 shipped `claim_outbox` with an unparseable CTE (`FOR UPDATE SKIP LOCKED`
  before `LIMIT`). Because plpgsql bodies compile at first call, applying migrations is
  not sufficient evidence that they work. The defect was fixed by ADDING migration
  `202610060006` (CREATE OR REPLACE with the corrected clause order) rather than editing
  the reviewed 0001-0005 set, preserving byte-exact provenance and the immutability rule.
- **ADR-010 Operating model: organization = intended technical Scheme/Hub Operator.**
  Rebaseline recorded 2026-10-08 from the PRD v1.2 packet dated 9 October 2026 (dated
  working assumptions, not legal findings). Supersedes the earlier 'product layer behind
  an external sponsoring-DFSP operator' framing for design/build. Target split: the
  organization owns, deploys, secures, and operates the central Hub infrastructure and
  executes central technical functions only under documented scheme rules and delegation;
  the sponsor DFSP retains settlement and risk accountability (policy, participant
  funding/liquidity, customer-account servicing) under the intended arrangement; a
  settlement partner performs external settlement-account movement and acknowledgements;
  the P2P/A2A app is a scheme product with no stored balance. Sudan/SDG and
  sponsor-license coverage are dated design/build assumptions only. Formal operator
  designation, sponsor/scheme agreements, jurisdictional legal validation, and the exact
  app route remain launch gates, not coding blockers (see D-08, B-01, B-10).
- **ADR-011 Operator workstream: chart-first Hub deployment.** The central Hub
  deployment unit is the official `mojaloop/mojaloop` umbrella Helm chart (v17.2.0
  test/reproducibility reference only), staged under `infra/mojaloop/` with a
  project-owned release manifest recording chart/dependency/image pins, checksums, and
  render evidence. Do not vendor Mojaloop source repositories as packages; do not deploy
  the DFSP SDK Scheme Adapter centrally; the Third Party overlay is conditional and off
  by default. No render/install claim may be made until a disposable cluster and Helm
  are actually available and exercised (B-10, TICKET-009/010).
- **ADR-012 Repository remains public (owner decision).** Decided by the owner on
  2026-10-09; supersedes ADR-002/D-05 for the current simulator-only stage. The repository
  stays public. Guardrails that keep this acceptable: no secrets or live credentials are
  ever committed (CI secret-scan enforces), everything partner-specific stays simulated
  behind `packages/ports`, and claim discipline (no render/install/live claims) applies
  regardless of visibility. Recommended while public: protect `main` (PR + green CI before
  merge), keep personal data out of commits, and re-evaluate visibility before any
  live-partner or production launch.
