# Local setup

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10.12.1 (`corepack enable`).
- Docker (or any disposable local Postgres 16) for database work.
- Versions are CI-proposed until the first green CI run (ADR-003).

## Install and verify

```bash
pnpm install --no-frozen-lockfile   # becomes --frozen-lockfile in TICKET-008
pnpm run typecheck
pnpm run test
pnpm run secret-scan
```

## Disposable local database

```bash
docker run --name eeeasy-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=eeeasy_pay \
  -p 5432:5432 -d postgres:16

psql "postgresql://postgres:postgres@127.0.0.1:5432/eeeasy_pay" -f ci/db/prepare.sql
for f in $(ls supabase/migrations/*.sql | sort); do
  psql "postgresql://postgres:postgres@127.0.0.1:5432/eeeasy_pay" -v ON_ERROR_STOP=1 -f "$f"
done
psql "postgresql://postgres:postgres@127.0.0.1:5432/eeeasy_pay" -v ON_ERROR_STOP=1 -f ci/db/smoke.sql
```

`prepare.sql` synthesizes the `auth` schema/roles that Supabase provides in managed
environments. It is for disposable local/CI databases ONLY. Never run migrations or
`prepare.sql` against any shared or real environment, and never use real customer or
partner data (`GUARDRAILS.md` #5, #6).

## What exists now vs what is next

Implemented: domain money/state/split logic with tests, PAL fingerprints and expiry
projection with tests, typed ports, deterministic sponsor-DFSP simulator with tests,
reviewed migrations 0001-0005, CI (typecheck/test/migrations/secret-scan).
Placeholder: apps/api (TICKET-003), apps/worker (TICKET-005), persistence (TICKET-004).
