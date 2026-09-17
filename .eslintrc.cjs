/**
 * ESLint 8 config (.cjs because the root package.json is not type: module).
 *
 * Deliberately narrow: `tsc --build` already covers type correctness, so this
 * enforces only the conventions in .claude/rules/ that the compiler cannot —
 * chiefly the no-`any` rule and the "never access process.env outside config.ts"
 * boundary.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'dist-types/',
    'coverage/',
    '**/*.js',
    '**/*.cjs',
    '**/*.mjs',
    'packages/db/prisma/migrations/',
  ],
  rules: {
    // Definition of Done: no new `any`.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
    ],
    // `_`-prefixed args are intentional throwaways (Express handlers etc.).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
  overrides: [
    {
      // The env boundary from .claude/rules/backend.md, enforced rather than
      // just documented.
      files: ['apps/**/*.ts'],
      excludedFiles: [
        'apps/*/src/config.ts',
        // Tooling config and E2E specs run outside the app and legitimately
        // read CI/ENV flags — the boundary is about application code.
        'apps/*/playwright.config.ts',
        'apps/*/vite.config.ts',
        'apps/ui/e2e/**',
      ],
      rules: {
        'no-restricted-properties': [
          'error',
          {
            object: 'process',
            property: 'env',
            message:
              'Do not read process.env directly — import `config` instead. Only apps/*/src/config.ts may touch it.',
          },
        ],
      },
    },
    {
      // Seed and one-off scripts legitimately print to stdout.
      files: ['packages/db/prisma/seed.ts', 'apps/worker/src/scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', 'apps/ui/e2e/**/*.ts'],
      env: { jest: true },
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
  ],
}
