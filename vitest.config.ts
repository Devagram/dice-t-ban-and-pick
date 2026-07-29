import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import react from '@vitejs/plugin-react'

// Two projects, because the code under test runs in two runtimes and pretending otherwise is
// how a "works on my machine" bug reaches production.
//
//   - `packages/*` are pure and run under Node.
//   - `apps/worker` runs in **workerd**, the same runtime Cloudflare deploys. That matters for
//     the Phase 3 exit criteria specifically: WebSocket hibernation, SQLite storage, and the
//     single-threaded execution §11's concurrency guarantee rests on cannot be faked in Node.
//
// No path aliases anywhere: npm workspaces symlink @banpick/* into node_modules and each
// package's `exports` points at its TypeScript source, so tests resolve exactly what the
// Durable Object will import.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './apps/worker/wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['apps/worker/test/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.tsx'],
          environment: 'happy-dom',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      /**
       * `packages/*` only, deliberately.
       *
       * The v8 provider collects nothing from **workerd** — running the worker suite with
       * coverage reports 0% across `apps/worker/src` while all 41 of its tests pass, because
       * the instrumentation does not cross into the Workers runtime. Including those files
       * would put 281 permanently-uncovered statements in the denominator and turn every
       * threshold into a number about the tooling rather than about the code.
       *
       * The worker's assurance is its integration suite: two headless clients playing complete
       * matches in the real runtime, plus the D18 and outbound structural checks. That is a
       * stronger statement than a line count, but it is not the same statement, and pretending
       * otherwise by lowering the global threshold would hide the packages' numbers too.
       */
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts'],
      reporter: ['text', 'json-summary'],
      // Phase 1 exit criteria: 100% branch on legalActions and project, >=90% line overall.
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        'packages/engine/src/legalActions.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'packages/engine/src/project.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
})
