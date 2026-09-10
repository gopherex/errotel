import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true,
    actionTimeout: 10_000,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'yarn example',
    url: 'http://127.0.0.1:14173',
    reuseExistingServer: !process.env.CI,
    cwd: new URL('../..', import.meta.url).pathname,
  },
})
