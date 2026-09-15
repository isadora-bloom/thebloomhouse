/**
 * Starts the app under test for the Playwright harness.
 *
 * Default: `next build` (Turbopack) once, then `next start`. That is what
 * E2E-PLAN.md says ("`next build` then `next start` on port 3100 with the
 * branch env") and it is why this launcher exists as a script rather than
 * a bare command: the env has to reach the build, because NEXT_PUBLIC_*
 * values are inlined at build time.
 *
 * The launcher ran `next dev` from 2026-09-15 until the same evening. Every
 * first request under dev compiled the page or route on the spot, and on
 * this machine that took 20s to 120s per page (register route 37s, the
 * couple dashboard's two data routes 71s each, /api/couple/branding 2.1
 * minutes cold). The journeys' waits are sized for the product, not for
 * webpack, so a section could fail on compile alone and pass on the
 * retry once the bundle was warm. A production build front-loads all of
 * that into one step and the runs measure the app.
 *
 *   E2E_DEV=1          run `next dev --webpack` instead (the old behaviour;
 *                      useful when iterating on one spec with HMR)
 *   E2E_SKIP_BUILD=1   reuse the last build in .next if there is one
 *   E2E_BUILD_ONLY=1   build and exit (for a warm cache before a run)
 *
 * The build in .next carries the branch's public keys, not production's.
 * `vercel` builds on its own machines and never reads this folder; a local
 * `next start` outside the harness would serve the branch build until the
 * next `next build`.
 *
 * Why a launcher rather than `webServer.env` in playwright.config.ts
 * (2026-09-15): Playwright's JSON reporter serialises the whole config,
 * `webServer.env` included, into e2e/results.json. With the branch env
 * handed over that way, every secret in .env.test landed in a report file
 * that was, at the time, tracked by git. The env now stays in this
 * process: the config passes only the env file name and the port, and
 * this script loads the file itself with the same loader (and the same
 * production refusal) the tests use.
 *
 * AI_E2E_STUB defaults on so a run never reaches the real model; set
 * E2E_LIVE_MODEL=1 to allow it.
 *
 * Dev mode stays on webpack: Turbopack has a reproducible crash on
 * Windows during dev CSS recompiles (BUG-DEV-01). The one-shot build is
 * Turbopack, like Vercel's.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadE2EEnv } from './helpers/env'

const loaded = loadE2EEnv()
const port = process.env.E2E_PORT ?? '3100'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...loaded.values,
  AI_E2E_STUB: process.env.E2E_LIVE_MODEL === '1' ? '0' : (process.env.AI_E2E_STUB ?? '1'),
  // next.config.ts drops Strict-Transport-Security under this flag: a
  // production build served over http://localhost would otherwise have
  // Chromium upgrade every request to https.
  E2E_HARNESS: '1',
}

function run(command: string): never {
  const child = spawn(command, { env, shell: true, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig))
  // Keep the process alive for the child; the exit handler above ends it.
  return undefined as never
}

if (process.env.E2E_DEV === '1') {
  run(`npx next dev --webpack -p ${port}`)
} else {
  const haveBuild = existsSync('.next/BUILD_ID')
  if (process.env.E2E_SKIP_BUILD === '1' && haveBuild) {
    console.log('[e2e] E2E_SKIP_BUILD=1 and .next/BUILD_ID exists: serving the last build')
  } else {
    // Turbopack for the build, as Vercel does. The Windows crash that keeps
    // dev on webpack (BUG-DEV-01) is a dev-mode CSS recompile; a one-shot
    // build completed cleanly on 2026-09-15, and the webpack build did not
    // (see src/lib/ai/e2e-stub.ts for the import it choked on).
    const started = Date.now()
    console.log('[e2e] next build (branch env)')
    const build = spawnSync('npx next build', { env, shell: true, stdio: 'inherit' })
    if (build.status !== 0) {
      console.error(`[e2e] build failed with status ${build.status ?? 'null'}`)
      process.exit(build.status ?? 1)
    }
    console.log(`[e2e] built in ${Math.round((Date.now() - started) / 1000)}s`)
  }
  if (process.env.E2E_BUILD_ONLY === '1') process.exit(0)
  run(`npx next start -p ${port}`)
}
