import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The Definition of Done requires 375px to render without layout breakage.
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  // Assumes `npm run dev` is already running, per the testing rules.
  webServer: process.env['CI']
    ? { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: false }
    : undefined,
})
