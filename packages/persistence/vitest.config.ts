import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All suites share ONE disposable CI database; run test files sequentially
    // so per-file TRUNCATE fixtures cannot race each other.
    fileParallelism: false,
  },
});
