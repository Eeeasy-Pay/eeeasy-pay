# Local setup (disposable environments only)

> This repository is a simulator-only product foundation. Nothing here connects to a real
> bank, DFSP, or Mojaloop switch, and no step may be run against a real environment.

## Requirements

- Node 22 (`.nvmrc`), pnpm 10.12.1 (`packageManager`), no lockfile committed yet (TICKET-008).
- A disposable Postgres 16 (or Supabase local) for migration checks. Never use a real database.

## Install / verify

```
pnpm install --no-frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
bash ci/secret-scan.sh
```

## Database migration check (disposable DB only)

```
psql -v ON_ERROR_STOP=1 -f ci/db/prepare.sql        # CI-only auth schema/roles fixture
for f in $(ls supabase/migrations/*.sql | sort); do psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -v ON_ERROR_STOP=1 -f ci/db/smoke.sql          # schema + invariants assertions
```

## CI failures are diagnosable from the run page

The `migrations` job runs psql with `ON_ERROR_STOP`. On failure the exact SQL error is
printed as a workflow **annotation** on the run page and appended to the job **summary**,
so a failed migration or smoke assertion can be diagnosed without downloading logs.
``` pages: Actions -> failing run -> Annotations / Summary. ```

## Toolchain status

Pins (Node 22 / pnpm 10.12.1 / turbo ^2.5 / vitest ^3.2 / TS ^5.8) become *verified* only
against green CI evidence; see `docs/implementation/DECISIONS.md` (ADR-003).
