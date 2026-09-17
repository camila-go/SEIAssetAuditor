/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  roots: ['<rootDir>/packages', '<rootDir>/apps'],
  // Runs before the module under test is imported, so `config.ts` can validate.
  setupFiles: ['<rootDir>/jest.setup.mjs'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  // Playwright E2E lives in apps/ui/e2e and runs under `npm run test:e2e`.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/'],
  moduleNameMapper: {
    // ESM source uses .js specifiers that ts-jest must resolve back to .ts.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capella/types$': '<rootDir>/packages/types/src/index.ts',
    '^@capella/embedding$': '<rootDir>/packages/embedding/src/index.ts',
    '^@capella/db$': '<rootDir>/packages/db/src/index.ts',
    '^@capella/queue$': '<rootDir>/packages/queue/src/index.ts',
    '^@capella/scraper$': '<rootDir>/packages/scraper/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  collectCoverageFrom: [
    'packages/scraper/src/**/*.ts',
    'apps/api/src/services/**/*.ts',
    '!**/*.test.ts',
    '!**/__tests__/**',
  ],
}
