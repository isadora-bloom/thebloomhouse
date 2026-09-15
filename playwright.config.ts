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
  // A broken node_modules surfaces as 500s deep in the app; check it first.
  globalSetup: './e2e/global-setup.ts',
  testMatch: ['sections/**/*.spec.ts', 'pending/**/*.spec.ts'],
  // 150s, not 60s: the app runs under `next dev --webpack` and the first
  // request to the platform shell or the couple portal compiles it, which
  // took over 60s on the 2026-09-15 runs and failed the first test of a
  // section on time alone. Later navigations are fast; the budget is for
  // the compile, and navigationTimeout below is raised for the same reason.
  timeout: 150_000,
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
    navigationTimeout: 90_000,
    // 45s covers the first-compile of an API route under the dev server
    // (the expired contract link answered in 8.5s cold and 0.3s warm on
    // 2026-09-15, and 15s was not enough with a second worker compiling).
    actionTimeout: 45_000,
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
        // Next loads `.env.local` itself, so pointing the harness at
        // `.env.test` is only half the job: the app under test would
        // still have come up on production. e2e/dev-server.ts loads the
        // branch file into the server's own process.env (which wins over
        // Next's dotenv) and refuses production the same way the tests do.
        // The values are NOT passed through `env` here on purpose: the
        // JSON reporter serialises this whole block into e2e/results.json,
        // and on 2026-09-15 that put every branch secret in a tracked file.
        // Only the file name and the port cross this boundary.
        command: `npx tsx e2e/dev-server.ts`,
        url: `http://localhost:${LOCAL_PORT}/welcome`,
        reuseExistingServer: true,
        // The launcher builds before it serves (E2E-PLAN: build then start),
        // and a cold `next build --webpack` is minutes, not seconds.
        timeout: 900_000,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          E2E_ENV_FILE: E2E_ENV.envFile,
          E2E_PORT: String(LOCAL_PORT),
        },
      }
    : undefined,
})
