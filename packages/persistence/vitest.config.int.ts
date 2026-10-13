import { defineConfig } from 'vitest/config';

// Integration tests against a disposable Postgres database (TEST_DATABASE_URL) with
// ci/db/prepare.sql and all supabase/migrations applied. Never point this at a real or
// shared environment (docs/implementation/GUARDRAILS.md).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
