import { defineConfig, devices } from '@playwright/test'
import { loadE2EEnv } from './e2e/helpers/env'

// The harness env. `.env.test` by default, `E2E_ENV_FILE` to name another,
// NEVER `.env.local` — that file points at production on every developer
// machine and is how the old suite came to seed and clean up against the
// live project. loadE2EEnv throws outright if the resulting
// NEXT_PUBLIC_SUPABASE_URL carries the production project ref, so a
// mis-pointed run dies here rather than at the first insert.
// See E2E-PLAN.md, "the one thing wrong with it".
const E2E_ENV = loadE2EEnv()

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
        // Next loads `.env.local` itself, so pointing the harness at
        // `.env.test` is only half the job — the app under test would
        // still have come up on production. Anything already present in
        // process.env wins over Next's own dotenv loading, so handing the
        // branch values in here closes that second door. AI_E2E_STUB
        // keeps the run off the real model (see src/lib/ai/e2e-stub.ts).
        env: {
          ...E2E_ENV.values,
          AI_E2E_STUB: process.env.AI_E2E_STUB ?? '1',
        },
      }
    : undefined,
})
