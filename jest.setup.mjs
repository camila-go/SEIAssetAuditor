/**
 * Minimum environment for unit tests.
 *
 * Service modules import `config.ts`, which validates at module load — without
 * these, importing a service to test one pure function throws. Values are
 * deliberately fake: no test in this suite opens a socket.
 *
 * Set before the module under test is imported, and only when not already
 * present so a real `.env.test` can override them.
 */
const TEST_ENV = {
  DATABASE_URL: 'postgresql://test@127.0.0.1:5432/capella_dam_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AEM_PUBLIC_HOST: 'https://www.capella.edu',
  NODE_ENV: 'test',
  // Phase 2/3 stay off so the gating paths are what the tests exercise.
  AEM_API_ENABLED: 'false',
  AEM_INTAKE_ENABLED: 'false',
  TRANSCRIPTION_ENABLED: 'false',
  SOCIAL_ENABLED: 'false',
  APPROVAL_CHAIN_MODE: 'sequential',
}

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] ??= value
}
