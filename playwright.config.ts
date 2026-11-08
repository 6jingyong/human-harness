import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'npm run start -- -p 3100',
    url: 'http://127.0.0.1:3100',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      HH_EXECUTOR: 'demo',
      HH_DATA_DIR: process.env.HH_DATA_DIR || '.human-harness-browser-smoke'
    }
  }
});
