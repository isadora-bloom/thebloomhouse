import { defineConfig, devices } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

// Load .env.local manually (no dotenv dep installed; minimal parser)
const envPath = path.join(__dirname, '.env.local')
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

const USE_LOCAL = process.env.E2E_USE_LOCAL !== 'false'
// Local port is 3100 by default to avoid collisions with other Next dev
// servers on 3000 (e.g. the Presshouse workspace). Override with E2E_PORT.
const LOCAL_PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = USE_LOCAL
  ? `http://localhost:${LOCAL_PORT}`
  : (process.env.E2E_BASE_URL || `http://localhost:${LOCAL_PORT}`)

export default defineConfig({
  testDir: './e2e',
  testMatch: ['sections/**/*.spec.ts', 'pending/**/*.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  workers: 2,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'e2e/results.json' }], ['html', { outputFolder: 'e2e/report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        // Use a Chromium-based mobile device descriptor so we don't require the
        // webkit browser binary. This still emulates a mobile viewport, touch
        // input, and mobile UA.
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: USE_LOCAL
    ? {
        // Force webpack (no Turbopack) — Turbopack has a reproducible crash on
        // Windows during CSS compiles that kills dev mid-run. See BUG-DEV-01.
        command: `npx next dev --webpack -p ${LOCAL_PORT}`,
        url: `http://localhost:${LOCAL_PORT}/welcome`,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
})
