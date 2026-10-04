import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config (ESLint 9+). `npm run lint` previously failed because no config
 * file existed at all.
 *
 * Phase 0 goal is a GREEN baseline over the existing code with zero behavior changes,
 * so a few rules that the current source would violate are deliberately downgraded to
 * 'warn' below and marked PHASE-0. Tighten them in later phases rather than deleting
 * them silently.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'python/**',
      '.venv/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    linterOptions: {
      // The existing source carries a stale `eslint-disable-next-line no-proto`
      // directive in FranklinWHService.ts; keep that a warning, not a failure.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // PHASE-0: `any` is used pervasively for untyped upstream API responses
      // (Tesla Fleet + the FranklinWH proxy). Re-enable once those payloads have types.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // PHASE-0: empty `catch {}` blocks exist in credentials.ts keychain fallbacks.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
