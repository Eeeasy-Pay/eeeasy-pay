import { defineConfig } from 'vitest/config';

// DB-free unit tests only. Integration tests (*.int.test.ts) need a disposable Postgres
// database via TEST_DATABASE_URL and run through `pnpm run test:integration`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.int.test.ts'],
  },
});
