import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  workers: 4,
  reporter: [['list'], ['json', { outputFile: 'e2e/results.json' }]],
  use: {
    baseURL: 'https://bloom-house-iota.vercel.app',
    screenshot: 'on',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
