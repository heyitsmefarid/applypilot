import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { headless: true },
  webServer: {
    command: 'node demo-site/server.mjs',
    url: 'http://localhost:4321/',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
