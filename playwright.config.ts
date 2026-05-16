import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Open VSX publishing automation
 */
export default defineConfig({
  testDir: './scripts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'https://open-vsx.org',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: false, // Keep visible for manual OAuth steps
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: undefined,
});
