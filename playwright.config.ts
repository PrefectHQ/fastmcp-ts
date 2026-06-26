import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  timeout: 60_000,
  use: { headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
