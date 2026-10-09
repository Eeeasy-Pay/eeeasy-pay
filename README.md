# eeeasy-pay (simulator-only prototype)

Phone-number-based P2P payments and bill splitting, implemented as a **product orchestration
layer** that would integrate through a sponsoring DFSP. This repository is a **simulator-only
engineering prototype**: it moves no real money, calls no production bank, DFSP, or Mojaloop
component, and holds no live credentials. It is not certified or launch-ready.

## Non-negotiable baseline

- eeeasy-pay is a consumer experience and orchestration layer. It is NOT a DFSP, wallet,
  custodian, deposit-taker, settlement bank, or controller of customer funds.
- All partner-dependent behavior sits behind typed ports with a deterministic simulator
  implementation. No partner API, fee schedule, alias policy, or release profile is invented.
- Product payment state, source-account posting, scheme transfer state, recipient credit,
  participant settlement, and reconciliation are kept as separate evidence dimensions. No
  quote, HTTP response, callback, or local row alone implies bank credit or settlement.

Read `docs/implementation/GUARDRAILS.md` before contributing.

## Repository layout

- `apps/api` - product HTTP API + versioned OpenAPI contract (TICKET-003)
- `apps/worker` - restart-safe outbox processing and inbox projection (TICKET-005)
- `packages/domain` - pure payment-state transitions, exact minor-unit money, deterministic splits
- `packages/contracts` - versioned request/response/event schemas and problem codes
- `packages/ports` - typed repository, clock, notification, and sponsor-DFSP connector interfaces
- `packages/pal` - quote binding, idempotency fingerprints, expiry projection, event/state mapping
- `packages/persistence` - narrow repository/transaction implementations (TICKET-004)
- `packages/sponsor-dfsp-connector` - deterministic simulator only; no live connector
- `infra/mojaloop` - operator-owned central Hub release inputs (TICKETS 009-010; reference only)
- `supabase/migrations` - reviewed ordered SQL (Postgres; Supabase-compatible roles/RLS)
- `ci/` - CI database fixtures, smoke assertions, secret scan
- `docs/implementation` - decisions, blockers, tickets, setup

## Local development

Requires Node 22 and pnpm 10.12.1 (see `.nvmrc`; versions are CI-proposed until the first
green CI run, see docs/implementation/DECISIONS.md ADR-003):

```bash
pnpm install --no-frozen-lockfile
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run secret-scan
```

Database (disposable local Postgres only; see `docs/implementation/SETUP.md`):

```bash
psql -f ci/db/prepare.sql                 # synthetic auth schema + roles (CI/local only)
for f in $(ls supabase/migrations/*.sql | sort); do psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -v ON_ERROR_STOP=1 -f ci/db/smoke.sql
```

## Status

Foundation + first vertical slice in progress. See `docs/implementation/TICKETS.md` for the
ticket workflow used with the coding agent, and `docs/implementation/OPEN_DECISIONS.md` for the
blockers that prevent any partner integration or real-money use.
