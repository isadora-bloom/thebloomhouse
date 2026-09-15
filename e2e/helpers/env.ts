/**
 * The one place the E2E harness learns which database it is pointed at.
 *
 * Why this file exists (E2E-PLAN.md, "the one thing wrong with it"):
 * `playwright.config.ts` used to load `.env.local`, which on every
 * developer machine points at the production Supabase project. The seed
 * helpers then built a service-role client from whatever they found in
 * `process.env` with no refusal of any kind. Every seed and every cleanup
 * in the old suite therefore wrote to production.
 *
 * The rule now:
 *
 *   1. The harness loads the env file named by `E2E_ENV_FILE`, default
 *      `.env.test`. It never reads `.env.local`.
 *   2. Values from that file WIN over anything already in `process.env`.
 *      The named file is the authority; an inherited shell variable
 *      pointing somewhere else is exactly the accident we are guarding
 *      against.
 *   3. If the resulting `NEXT_PUBLIC_SUPABASE_URL` carries the production
 *      project ref, everything throws. Nothing starts, nothing seeds.
 *
 * The refusal is copied in shape from `tests/golden/run-golden-cases.ts`
 * (gap G16), which has had the same guard since D-12.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The production Supabase project ref. Never write here. */
export const PROD_SUPABASE_REF = 'jsxxgwprxuqgcauzlxcb'

/** Default env file. Overridable with E2E_ENV_FILE. */
export const DEFAULT_E2E_ENV_FILE = '.env.test'

/**
 * The file the harness must never load. `.env.local` is the production
 * config on a developer machine; naming it here makes the refusal
 * explicit rather than implied by the default.
 */
export const FORBIDDEN_ENV_FILE = '.env.local'

export class ProductionRefusedError extends Error {
  readonly url: string
  constructor(url: string, source: string) {
    super(
      `REFUSING to run the E2E harness against production (${url}), named by ${source}. ` +
        `Point NEXT_PUBLIC_SUPABASE_URL at a Supabase branch in ${envFileName()} (gap G16).`
    )
    this.name = 'ProductionRefusedError'
    this.url = url
  }
}

/** Which env file this run is supposed to use. */
export function envFileName(): string {
  const named = process.env.E2E_ENV_FILE?.trim()
  return named && named.length > 0 ? named : DEFAULT_E2E_ENV_FILE
}

/**
 * Minimal `KEY=value` parser. No dotenv dependency is installed and the
 * repo's other env readers (run-golden-cases, run-migration) use the same
 * shape, so this stays deliberately small: one assignment per line,
 * `#` comments, optional surrounding quotes.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    if (!key) continue
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Throws when `url` names the production project. Exported on its own so
 * anything holding a URL (a script, a test, a helper) can ask the same
 * question without loading a file.
 */
export function assertNotProduction(url: string | undefined, source: string): void {
  if (url && url.includes(PROD_SUPABASE_REF)) {
    throw new ProductionRefusedError(url, source)
  }
}

export interface LoadedE2EEnv {
  /** The file name that was asked for (e.g. `.env.test`). */
  envFile: string
  /** Absolute path that was looked at. */
  envPath: string
  /** Whether that file existed. */
  found: boolean
  /** Everything parsed out of the file (empty when it was missing). */
  values: Record<string, string>
  /** The effective Supabase URL after the file was applied. */
  supabaseUrl: string
  /** Service-role key, when the env carries one. */
  serviceRoleKey: string
  /** Anon key, when the env carries one. */
  anonKey: string
}

let cached: LoadedE2EEnv | null = null

/**
 * Load the harness env, apply it to `process.env`, and refuse production.
 *
 * Cached: the first caller pays for the read, everyone else gets the same
 * object. Pass `{ reload: true }` in a test that wants a fresh read.
 *
 * A missing env file is a warning, not a throw — `npx playwright test
 * --list` and `npx tsc` have to work in a checkout that has no branch
 * credentials. What is never allowed is a production URL, wherever it
 * came from.
 */
export function loadE2EEnv(opts: { reload?: boolean; cwd?: string } = {}): LoadedE2EEnv {
  if (cached && !opts.reload) return cached

  const envFile = envFileName()
  if (envFile === FORBIDDEN_ENV_FILE) {
    throw new Error(
      `E2E_ENV_FILE is ${FORBIDDEN_ENV_FILE}. That file is the production config on a ` +
        'developer machine and the harness will not load it. Use .env.test.'
    )
  }

  const root = opts.cwd ?? process.cwd()
  const envPath = resolve(root, envFile)
  const found = existsSync(envPath)
  const values = found ? parseEnvFile(readFileSync(envPath, 'utf8')) : {}

  if (!found) {
    console.warn(
      `[e2e] ${envFile} not found at ${envPath}. Falling back to the ambient environment. ` +
        'A run that needs a database will fail; --list and --noEmit will not.'
    )
  }

  // The named file wins. An inherited NEXT_PUBLIC_SUPABASE_URL from the
  // shell is the accident this whole file exists to stop.
  for (const [k, v] of Object.entries(values)) process.env[k] = v

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  assertNotProduction(supabaseUrl, found ? envPath : 'the ambient environment')

  // The branch file must carry the browser key as well as the URL. Next
  // fills any gap from .env.local, so a file without
  // NEXT_PUBLIC_SUPABASE_ANON_KEY sends production's publishable key to the
  // branch's auth endpoint and every sign-in answers 401 (section 32, the
  // vendor page, 2026-09-15). Better to stop here and say so.
  if (found) {
    const missing = ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !values[k])
    if (missing.length > 0) {
      throw new Error(
        `${envFile} is missing ${missing.join(' and ')}. Both must name the branch project ` +
          `(${supabaseUrl || 'unknown URL'}); without them Next borrows production's values from .env.local. ` +
          'The publishable key is under Project Settings, API Keys, in the Supabase dashboard for that project.'
      )
    }
  }

  cached = {
    envFile,
    envPath,
    found,
    values,
    supabaseUrl,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  }
  return cached
}

/** Test-only: drop the memoised load so the next call re-reads. */
export function resetLoadedE2EEnv(): void {
  cached = null
}
