# Decision record (ADRs)

- **ADR-001 Monorepo structure.** Fresh repository with Turborepo/pnpm: `apps/api`,
  `apps/worker`, `packages/{domain,contracts,ports,pal,persistence,sponsor-dfsp-connector}`,
  `supabase/migrations`, `ci/`, `docs/implementation`. Deployables stay independently
  buildable.
- **ADR-002 Private repository.** The repository must be private (pre-launch fintech work).
  Revised from an initially proposed public repo. NOTE: the repository currently exists as a
  public org repo; flipping it to private is a pending owner action (B-09). Record here once done.
- **ADR-003 Toolchain pins.** Node 22, pnpm 10.12.1, turbo ^2.5.0, vitest ^3.2.0,
  TypeScript ^5.8.0. CI installs with `pnpm install --no-frozen-lockfile` until a lockfile
  is committed (TICKET-008). VERIFIED 2026-10-08 by the first fully green CI run
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
