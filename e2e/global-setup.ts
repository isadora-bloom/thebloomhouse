/**
 * Runs once before the harness starts the app under test.
 *
 * Two things, both found on the first section 32 run (2026-09-15):
 *
 * 1. A broken install must stop the run here, with a plain message. Four
 *    public API routes answered 500 because node_modules/prettier was an
 *    empty directory: webpack could not resolve `prettier/plugins/html`
 *    inside @react-email/render, which resend imports, which the email
 *    transport imports, which the AI client imports, which most API routes
 *    reach. `npm ls` had been reporting it as `invalid` all along.
 *
 * 2. Rate limit buckets are cleared on the branch. The limited routes
 *    (contract signing: a handful per five minutes per IP) see every run,
 *    every retry and every worker as the same localhost address, so the
 *    second run of a section answers 429 where the first answered 409.
 *    The product limit stays as it is; the branch's counters do not
 *    outlive a run. adminClient() refuses production, so this can never
 *    touch a live counter.
 */
import { spawnSync } from 'node:child_process'
import { adminClient } from './helpers/seed'

function assertInstallHealthy(): void {
  const r = spawnSync('npm ls --depth=0', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 120_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // `extraneous` is noise (sharp's optional wasm builds); `invalid` is the
  // empty-directory case that started this, `missing` a deleted package.
  const problems = out
    .split(/\r?\n/)
    .filter((l) => /\b(invalid|missing|UNMET|ELSPROBLEMS)\b/.test(l) && !/^npm warn/.test(l))
  if (problems.length > 0) {
    throw new Error(
      'node_modules does not match package-lock.json; run `npm install` before the E2E harness.\n' +
        problems.slice(0, 12).join('\n'),
    )
  }
}

async function clearRateLimitBuckets(): Promise<void> {
  const sb = adminClient()
  const { error, count } = await sb.from('rate_limit_buckets').delete({ count: 'exact' }).neq('key', '')
  if (error) throw new Error(`could not clear rate_limit_buckets on the branch: ${error.message}`)
  console.log(`[global-setup] cleared ${count ?? 0} rate limit bucket(s) on the branch`)
}

export default async function globalSetup(): Promise<void> {
  assertInstallHealthy()
  await clearRateLimitBuckets()
}
