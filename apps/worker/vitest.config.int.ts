import { defineConfig } from 'vitest/config';

// Integration tests against a disposable Postgres database (TEST_DATABASE_URL) with
// ci/db/prepare.sql and all supabase/migrations applied. Never point this at a real or
// shared environment (docs/implementation/GUARDRAILS.md).
//
// Files run strictly one at a time and each one begins with a full truncate of the app
// tables (src/int-setup.ts, shared with packages/persistence), so outbox state, event
// counts, and inbox rows never leak across files.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    setupFiles: ['src/int-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
