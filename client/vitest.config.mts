/**
 * Unit tests for the client's pure helpers.
 *
 * `environment: 'node'` on purpose: everything under test here is a pure
 * function over strings and numbers, and pulling in jsdom to run it would add a
 * dependency and several seconds to buy nothing. The day a component test lands
 * it brings its own environment with it, either through
 * `// @vitest-environment jsdom` at the top of that file or a `projects` entry —
 * both of which are cheaper than making every test in the workspace pay for a
 * DOM it never touches.
 *
 * The `@/` alias is declared here as well as in `vite.config.ts` because Vitest
 * does not read the app's build config, and `tsconfig.json`'s `paths` only
 * teaches the type-checker. All three have to agree.
 *
 * The extension is `.mts`, matching the server's: `client/package.json` is
 * `"type": "module"`, so a `.ts` config would be loaded as ESM by Node and as
 * CJS by anything that still guesses, and `.mts` removes the guess.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'src/components/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
