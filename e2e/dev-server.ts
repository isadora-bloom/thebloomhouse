/**
 * Starts the app under test for the Playwright harness.
 *
 * Why a launcher rather than `webServer.env` in playwright.config.ts
 * (2026-09-15): Playwright's JSON reporter serialises the whole config,
 * `webServer.env` included, into e2e/results.json. With the branch env
 * handed over that way, every secret in .env.test (service role key,
 * Anthropic key, cron and signing secrets) landed in a report file that
 * was, at the time, tracked by git. check-no-secrets caught it before a
 * commit. The env now stays in this process: the config passes only the
 * env file name and the port, and this script loads the file itself with
 * the same loader (and the same production refusal) the tests use.
 *
 * AI_E2E_STUB defaults on so a run never reaches the real model; set
 * E2E_LIVE_MODEL=1 to allow it.
 */
import { spawn } from 'node:child_process'
import { loadE2EEnv } from './helpers/env'

const loaded = loadE2EEnv()
const port = process.env.E2E_PORT ?? '3100'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...loaded.values,
  AI_E2E_STUB: process.env.E2E_LIVE_MODEL === '1' ? '0' : (process.env.AI_E2E_STUB ?? '1'),
}

// Force webpack (no Turbopack): Turbopack has a reproducible crash on
// Windows during CSS compiles that kills dev mid-run. See BUG-DEV-01.
const child = spawn(`npx next dev --webpack -p ${port}`, { env, shell: true, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig))
