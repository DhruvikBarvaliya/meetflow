import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // Integration tests share one PostgreSQL database; running files in
    // parallel would let them truncate each other's fixtures mid-assertion.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    setupFiles: ['tests/setup.ts'],
    // Only the integration project needs a migrated database; unit tests run
    // with `--project`-free invocation and simply skip the cost via the guard
    // inside globalSetup's callers.
    globalSetup: ['tests/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/**/*.d.ts', 'src/database/models/**'],
    },
  },
});
