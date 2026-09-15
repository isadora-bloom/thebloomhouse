/**
 * The harness must refuse production. This is the proof.
 *
 * Runs under vitest (see vitest.config.ts include), not Playwright — it
 * needs no browser and no database, and it has to pass on every commit,
 * not only on the nights the e2e suite runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotProduction,
  loadE2EEnv,
  resetLoadedE2EEnv,
  parseEnvFile,
  envFileName,
  ProductionRefusedError,
  PROD_SUPABASE_REF,
  FORBIDDEN_ENV_FILE,
} from '../env'

const PROD_URL = `https://${PROD_SUPABASE_REF}.supabase.co`
const BRANCH_URL = 'https://ciwqxwohczzthvzqqgjx.supabase.co'

let dir: string
const savedEnv = { ...process.env }

function writeEnv(name: string, body: string): void {
  writeFileSync(join(dir, name), body, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-env-'))
  resetLoadedE2EEnv()
  delete process.env.E2E_ENV_FILE
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetLoadedE2EEnv()
  process.env = { ...savedEnv }
})

describe('assertNotProduction', () => {
  it('throws on the production project ref', () => {
    expect(() => assertNotProduction(PROD_URL, 'a test')).toThrow(ProductionRefusedError)
    expect(() => assertNotProduction(PROD_URL, 'a test')).toThrow(/REFUSING/)
  })

  it('lets a branch url through', () => {
    expect(() => assertNotProduction(BRANCH_URL, 'a test')).not.toThrow()
  })

  it('lets an absent url through — nothing to refuse yet', () => {
    expect(() => assertNotProduction(undefined, 'a test')).not.toThrow()
    expect(() => assertNotProduction('', 'a test')).not.toThrow()
  })
})

describe('loadE2EEnv', () => {
  it('refuses when the named env file points at production', () => {
    writeEnv('.env.test', `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\nSUPABASE_SERVICE_ROLE_KEY=x\n`)
    expect(() => loadE2EEnv({ reload: true, cwd: dir })).toThrow(ProductionRefusedError)
  })

  it('refuses when the ambient environment points at production and no file exists', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_URL
    expect(() => loadE2EEnv({ reload: true, cwd: dir })).toThrow(/REFUSING/)
  })

  it('loads a branch env file and lets the file win over the shell', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_URL
    writeEnv(
      '.env.test',
      `NEXT_PUBLIC_SUPABASE_URL=${BRANCH_URL}\nSUPABASE_SERVICE_ROLE_KEY=branch-key\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key\n`
    )
    const env = loadE2EEnv({ reload: true, cwd: dir })
    expect(env.found).toBe(true)
    expect(env.supabaseUrl).toBe(BRANCH_URL)
    expect(env.serviceRoleKey).toBe('branch-key')
    expect(env.anonKey).toBe('anon-key')
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe(BRANCH_URL)
  })

  it('honours E2E_ENV_FILE', () => {
    process.env.E2E_ENV_FILE = '.env.branch'
    writeEnv(
      '.env.branch',
      `NEXT_PUBLIC_SUPABASE_URL=${BRANCH_URL}\nSUPABASE_SERVICE_ROLE_KEY=branch-key\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key\n`
    )
    expect(envFileName()).toBe('.env.branch')
    expect(loadE2EEnv({ reload: true, cwd: dir }).supabaseUrl).toBe(BRANCH_URL)
  })

  it('will not load .env.local even when asked directly', () => {
    process.env.E2E_ENV_FILE = FORBIDDEN_ENV_FILE
    writeEnv(FORBIDDEN_ENV_FILE, `NEXT_PUBLIC_SUPABASE_URL=${BRANCH_URL}\n`)
    expect(() => loadE2EEnv({ reload: true, cwd: dir })).toThrow(/will not load it/)
  })

  it('refuses a branch file without the browser key, naming what is missing', () => {
    // Without NEXT_PUBLIC_SUPABASE_ANON_KEY in the file, Next borrows
    // production's publishable key from .env.local and every sign-in
    // against the branch answers 401 (section 32, 2026-09-15).
    writeEnv('.env.test', `NEXT_PUBLIC_SUPABASE_URL=${BRANCH_URL}\nSUPABASE_SERVICE_ROLE_KEY=branch-key\n`)
    expect(() => loadE2EEnv({ reload: true, cwd: dir })).toThrow(/missing NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })

  it('survives a missing env file so --list and --noEmit still work', () => {
    const env = loadE2EEnv({ reload: true, cwd: dir })
    expect(env.found).toBe(false)
    expect(env.values).toEqual({})
  })
})

describe('parseEnvFile', () => {
  it('reads assignments, skips comments and strips quotes', () => {
    const parsed = parseEnvFile(
      ['# a comment', 'PLAIN=one', 'QUOTED="two"', "SINGLE='three'", 'EMPTY=', 'no_equals'].join('\n')
    )
    expect(parsed).toEqual({ PLAIN: 'one', QUOTED: 'two', SINGLE: 'three', EMPTY: '' })
  })

  it('keeps the equals signs inside a value', () => {
    expect(parseEnvFile('KEY=a=b=c').KEY).toBe('a=b=c')
  })
})
