import { defineConfig } from 'vitest/config';

// Integration tests against a disposable Postgres database (TEST_DATABASE_URL) with
// ci/db/prepare.sql and all supabase/migrations applied. Never point this at a real or
// shared environment (docs/implementation/GUARDRAILS.md).
//
// Files run strictly one at a time and each one begins with a full truncate of the app
// tables (src/int-setup.ts). Outbox claims, RLS row counts, and replay probes observe
// whole-table state, so cross-file row leakage (parallel workers sharing one database)
// would make assertions nondeterministic.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    setupFiles: ['src/int-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
