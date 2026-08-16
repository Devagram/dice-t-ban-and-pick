import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Two of the three day-one CI checks live here (see docs/DELIVERY-PLAN.md, Cross-cutting):
 *
 *   1. The D18 package boundary — the client may import @banpick/types and never
 *      @banpick/engine. npm workspaces hoist, so nothing physically stops the import;
 *      this rule plus scripts/check-boundaries.mjs is the whole boundary.
 *   2. The no-IO rule on @banpick/engine — spec §5 requires reduce/legalActions/project
 *      to be pure with zero IO, and Phase 1's purity gate lints for it rather than
 *      trusting review.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Build output: the bundled client, and the generated mode bundle. Both are compared
      // against their sources elsewhere; linting them is linting a minifier.
      'apps/worker/public/**',
      'apps/worker/src/generated/**',
      // `wrangler dev` leaves bundled scratch files here.
      '**/.wrangler/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // --- Check 2: no IO, no ambient nondeterminism, inside the pure packages --------
  //
  // `packages/bracket` (D37) is here for the same reasons `packages/engine` is, not by analogy:
  // a bracket is a fold over a result log, so a wall clock or an unseeded shuffle would make a
  // tournament unreproducible the moment its Durable Object hibernated. The seeding draw takes
  // its randomness from the creation event, exactly as the dice do.
  {
    files: ['packages/engine/src/**/*.ts', 'packages/bracket/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'os', 'http', 'https'],
              message:
                'These packages are pure: zero IO (spec §5). If you need a file, it belongs to the loader.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'These are pure functions of their event logs (spec §9/D9). Wall-clock time is not an input.',
        },
        {
          name: 'crypto',
          message:
            'Randomness is seeded from the creation event — see D9, §11.1, and the bracket rng note.',
        },
        {
          name: 'process',
          message: 'Pure package: no environment access.',
        },
        // Visible to the type checker since `lib` gained DOM for apps/web. TypeScript's lib is
        // a whole-program setting, so the engine's zero-IO boundary is enforced here by name.
        { name: 'fetch', message: 'Pure package: zero IO (spec §5).' },
        { name: 'WebSocket', message: 'Pure package: zero IO (spec §5).' },
        { name: 'localStorage', message: 'Pure package: zero IO (spec §5).' },
        { name: 'document', message: 'Pure package: no UI and no DOM.' },
        { name: 'window', message: 'Pure package: no UI and no DOM.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Replay must be exact (§11 non-negotiable 1). Use the counter-based RNG in rng.ts.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'A pure function of its event log. Wall-clock time is not an input.',
        },
      ],
    },
  },

  // --- Check 1, lint half: the client never receives the rules engine (D18) -------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      // The client is the one place in this repo that legitimately runs in a browser.
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        WebSocket: 'readonly',
        MessageEvent: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        addEventListener: 'readonly',
        removeEventListener: 'readonly',
        HTMLButtonElement: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@banpick/engine', '@banpick/engine/*'],
              message:
                'D18: the client renders legalActions() and never computes legality. It is not given the code that could.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/test/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Build tooling runs on Node, unlike everything it checks.
  {
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Object: 'readonly',
        // scripts/fetch-hero-art.mjs reaches the network, on purpose and outside the build.
        fetch: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
)
