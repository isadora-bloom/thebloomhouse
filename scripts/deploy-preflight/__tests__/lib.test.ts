/**
 * Unit tests for the pure parts of scripts/deploy-preflight.mjs.
 *
 * Two things are pinned here, per the W71 brief:
 *   1. deriveRequiredSecrets: the required-secret list built by reading
 *      source text, not a hand list, so a rename or a raised floor in
 *      the real files is caught rather than silently ignored.
 *   2. evaluateVercelLink: the link-team comparison that catches the
 *      isadoraandco / bloom-house "linked to the wrong team" class.
 *
 * Fixture source text below is a trimmed stand-in for the real files
 * (src/lib/cron-auth.ts etc.), not a copy of them. These tests check
 * the derivation's regex contract, not the current file contents.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveRequiredSecrets,
  evaluateVercelLink,
  parseProjectLsTable,
  parseEnvLsNames,
  parseEnvLineLength,
  parsePendingMigrationsDryRun,
} from '../lib.mjs'

// ---------------------------------------------------------------------------
// deriveRequiredSecrets
// ---------------------------------------------------------------------------

const FIXTURE_CRON_AUTH = `
export const MIN_SECRET_LENGTH = 32

export function verifyCronAuth(req) {
  const baseSecret = process.env.CRON_SECRET
  if (inProduction() && baseSecret.length < MIN_SECRET_LENGTH) { /* ... */ }
  const destSecret = process.env.CRON_SECRET_DESTRUCTIVE
}
`

const FIXTURE_STRIPE_ROUTE = `
export async function POST(request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
}
`

const FIXTURE_CALENDLY_ROUTE = `
export async function POST(request) {
  const webhookSecret = process.env.CALENDLY_WEBHOOK_SECRET
  if (!webhookSecret) return NextResponse.json({ error: 'calendly_not_configured' }, { status: 503 })
}
`

const FIXTURE_OAUTH_STATE = `
function getSigningKey() {
  const secret = process.env.STATE_SIGNING_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('STATE_SIGNING_SECRET is missing or too short (need >= 16 chars).')
  }
  return Buffer.from(secret, 'utf-8')
}
`

const FIXTURE_DEMO_TOKEN = `
function getSigningKey() {
  const secret = process.env.DEMO_SIGNING_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('DEMO_SIGNING_SECRET is missing or too short (need >= 16 chars).')
  }
  return Buffer.from(secret, 'utf-8')
}
`

const VALID_SOURCES = {
  cronAuthSrc: FIXTURE_CRON_AUTH,
  stripeRouteSrc: FIXTURE_STRIPE_ROUTE,
  calendlyRouteSrc: FIXTURE_CALENDLY_ROUTE,
  oauthStateSrc: FIXTURE_OAUTH_STATE,
  demoTokenSrc: FIXTURE_DEMO_TOKEN,
}

describe('deriveRequiredSecrets', () => {
  it('derives every required secret with the right minimum length, from source text alone', () => {
    const secrets = deriveRequiredSecrets(VALID_SOURCES)
    const byName = Object.fromEntries(secrets.map((s) => [s.name, s]))

    expect(byName.CRON_SECRET.minLength).toBe(32)
    expect(byName.CRON_SECRET_DESTRUCTIVE.minLength).toBeNull()
    expect(byName.STRIPE_WEBHOOK_SECRET.minLength).toBeNull()
    expect(byName.CALENDLY_WEBHOOK_SECRET.minLength).toBeNull()
    expect(byName.STATE_SIGNING_SECRET.minLength).toBe(16)
    expect(byName.DEMO_SIGNING_SECRET.minLength).toBe(16)
    expect(byName.SUPABASE_SERVICE_ROLE_KEY.minLength).toBeNull()
    expect(byName.NEXT_PUBLIC_SUPABASE_URL.minLength).toBeNull()
    expect(byName.ANTHROPIC_API_KEY.minLength).toBeNull()
    expect(byName.RESEND_API_KEY.minLength).toBeNull()

    expect(secrets).toHaveLength(10)
  })

  it('tracks a raised CRON_SECRET floor rather than a stale hand-copied number', () => {
    const raised = VALID_SOURCES.cronAuthSrc.replace('MIN_SECRET_LENGTH = 32', 'MIN_SECRET_LENGTH = 48')
    const secrets = deriveRequiredSecrets({ ...VALID_SOURCES, cronAuthSrc: raised })
    expect(secrets.find((s) => s.name === 'CRON_SECRET')?.minLength).toBe(48)
  })

  it('follows a renamed destructive-tier variable rather than the old name', () => {
    const renamed = VALID_SOURCES.cronAuthSrc.replace(
      'CRON_SECRET_DESTRUCTIVE',
      'CRON_SECRET_DANGEROUS',
    )
    const secrets = deriveRequiredSecrets({ ...VALID_SOURCES, cronAuthSrc: renamed })
    expect(secrets.map((s) => s.name)).toContain('CRON_SECRET_DANGEROUS')
    expect(secrets.map((s) => s.name)).not.toContain('CRON_SECRET_DESTRUCTIVE')
  })

  it('throws rather than silently deriving nothing when the source no longer matches', () => {
    const noFloor = VALID_SOURCES.cronAuthSrc.replace('export const MIN_SECRET_LENGTH = 32', '')
    expect(() => deriveRequiredSecrets({ ...VALID_SOURCES, cronAuthSrc: noFloor })).toThrow(
      /MIN_SECRET_LENGTH/,
    )

    expect(() =>
      deriveRequiredSecrets({ ...VALID_SOURCES, oauthStateSrc: '// no floor here' }),
    ).toThrow(/STATE_SIGNING_SECRET/)
  })
})

// ---------------------------------------------------------------------------
// parseProjectLsTable / evaluateVercelLink
// ---------------------------------------------------------------------------

// A trimmed, real shape of `vercel project ls --scope <x>` output (captured
// 2026-09-14 against the-bloom-house team; names and hosts only, no ids).
const PROJECT_LS_CORRECT_TEAM = `
Vercel CLI 50.23.2
Fetching projects in the-bloom-house
> Projects found under the-bloom-house  [857ms]

  Project Name            Latest Production URL                 Updated   Node Version
  rixey-app               https://rixey-app.vercel.app          4m        24.x
  bloom-house             https://bloom-house-iota.vercel.app   5d        24.x
  isadoraandco            https://www.isadoraandco.com          11d       24.x
`

const PROJECT_LS_WRONG_TEAM = `
Vercel CLI 50.23.2
Fetching projects in isadoras-projects
> Projects found under isadoras-projects  [500ms]

  Project Name            Latest Production URL                 Updated   Node Version
  some-old-experiment     --                                     2y        18.x
`

const BASE_LINK_INPUT = {
  expectedTeamSlug: 'the-bloom-house',
  expectedProjectName: 'bloom-house',
  expectedProductionHost: 'bloom-house-iota.vercel.app',
  whoamiOk: true,
}

describe('parseProjectLsTable', () => {
  it('parses project name and production URL out of the padded CLI table', () => {
    const rows = parseProjectLsTable(PROJECT_LS_CORRECT_TEAM)
    expect(rows).toContainEqual({ name: 'bloom-house', productionUrl: 'https://bloom-house-iota.vercel.app' })
  })

  it('reports a project with no production deployment as null, not the literal "--"', () => {
    const rows = parseProjectLsTable(PROJECT_LS_WRONG_TEAM)
    expect(rows).toContainEqual({ name: 'some-old-experiment', productionUrl: null })
  })
})

describe('evaluateVercelLink', () => {
  it('passes when the linked project matches the expected team and production host', () => {
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      projectJsonText: JSON.stringify({
        orgId: 'team_0Jqi4IXCcDaR5xVJ4Bez46gn',
        projectId: 'prj_MJPMOVEjifFrFZYEEm1B1HtkpapX',
        projectName: 'bloom-house',
      }),
      projectLsStdout: PROJECT_LS_CORRECT_TEAM,
      projectLsError: null,
    })
    expect(result.pass).toBe(true)
  })

  it('fails when .vercel/project.json does not exist', () => {
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      projectJsonText: null,
      projectLsStdout: null,
      projectLsError: null,
    })
    expect(result.pass).toBe(false)
    expect(result.lines[0].detail).toMatch(/does not exist/)
  })

  it('fails the isadoraandco/bloom-house class, where orgId resolves to a team without the expected production host', () => {
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      projectJsonText: JSON.stringify({
        orgId: 'team_wrongteam000000000000',
        projectId: 'prj_somethingelse',
        projectName: 'bloom-house',
      }),
      // This is what the CLI prints for the *wrong* org: it doesn't even
      // list a project called bloom-house.
      projectLsStdout: PROJECT_LS_WRONG_TEAM,
      projectLsError: null,
    })
    expect(result.pass).toBe(false)
    expect(result.lines.some((l) => !l.pass && /does not host a project named/.test(l.detail))).toBe(true)
  })

  it('fails when the project is present in that org but its production URL does not match', () => {
    const wrongHost = PROJECT_LS_CORRECT_TEAM.replace(
      'https://bloom-house-iota.vercel.app',
      'https://bloom-house-staging.vercel.app',
    )
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      projectJsonText: JSON.stringify({
        orgId: 'team_0Jqi4IXCcDaR5xVJ4Bez46gn',
        projectId: 'prj_MJPMOVEjifFrFZYEEm1B1HtkpapX',
        projectName: 'bloom-house',
      }),
      projectLsStdout: wrongHost,
      projectLsError: null,
    })
    expect(result.pass).toBe(false)
    expect(result.lines.some((l) => !l.pass && /production URL is/.test(l.detail))).toBe(true)
  })

  it('fails when projectName in project.json does not match, even if the org check would pass', () => {
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      projectJsonText: JSON.stringify({
        orgId: 'team_0Jqi4IXCcDaR5xVJ4Bez46gn',
        projectId: 'prj_someOtherProject',
        projectName: 'bloom-house-staging',
      }),
      projectLsStdout: PROJECT_LS_CORRECT_TEAM,
      projectLsError: null,
    })
    expect(result.pass).toBe(false)
  })

  it('fails when vercel whoami did not succeed, independent of the link check', () => {
    const result = evaluateVercelLink({
      ...BASE_LINK_INPUT,
      whoamiOk: false,
      projectJsonText: JSON.stringify({
        orgId: 'team_0Jqi4IXCcDaR5xVJ4Bez46gn',
        projectId: 'prj_MJPMOVEjifFrFZYEEm1B1HtkpapX',
        projectName: 'bloom-house',
      }),
      projectLsStdout: PROJECT_LS_CORRECT_TEAM,
      projectLsError: null,
    })
    expect(result.pass).toBe(false)
    expect(result.lines.some((l) => !l.pass && /whoami/.test(l.detail))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseEnvLsNames / parseEnvLineLength
// ---------------------------------------------------------------------------

const ENV_LS_OUTPUT = `
Vercel CLI 50.23.2
Retrieving project…
> Environment Variables found for the-bloom-house/bloom-house [188ms]

 name                               value               environments        created
 CRON_SECRET                        Encrypted           Production          161d ago
 ANTHROPIC_API_KEY                  Encrypted           Production          161d ago
 SUPABASE_SERVICE_ROLE_KEY          Encrypted           Production          161d ago
`

describe('parseEnvLsNames', () => {
  it('extracts variable names only, never the "Encrypted" value column', () => {
    const names = parseEnvLsNames(ENV_LS_OUTPUT)
    expect(names.has('CRON_SECRET')).toBe(true)
    expect(names.has('ANTHROPIC_API_KEY')).toBe(true)
    expect(names.has('SUPABASE_SERVICE_ROLE_KEY')).toBe(true)
    expect(names.has('Encrypted')).toBe(false)
  })

  it('reports the three secrets absent from the 2026-09-14 incident as missing', () => {
    const names = parseEnvLsNames(ENV_LS_OUTPUT)
    expect(names.has('CRON_SECRET_DESTRUCTIVE')).toBe(false)
    expect(names.has('STRIPE_WEBHOOK_SECRET')).toBe(false)
    expect(names.has('CALENDLY_WEBHOOK_SECRET')).toBe(false)
  })
})

describe('parseEnvLineLength', () => {
  it('measures the length of a quoted value without returning the value', () => {
    const result = parseEnvLineLength('CRON_SECRET="abc12"')
    expect(result).toEqual({ key: 'CRON_SECRET', length: 5 })
  })

  it('measures a bare, unquoted value the same way', () => {
    const result = parseEnvLineLength('NODE_ENV=production')
    expect(result).toEqual({ key: 'NODE_ENV', length: 10 })
  })

  it('reproduces the 2026-09-14 incident: a 21-character CRON_SECRET under the 32-char floor', () => {
    const twentyOneChars = 'a'.repeat(21)
    const result = parseEnvLineLength(`CRON_SECRET="${twentyOneChars}"`)
    expect(result?.length).toBe(21)
    expect(result!.length).toBeLessThan(32)
  })

  it('ignores comment lines and blank lines', () => {
    expect(parseEnvLineLength('# Created by Vercel CLI')).toBeNull()
    expect(parseEnvLineLength('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parsePendingMigrationsDryRun
// ---------------------------------------------------------------------------

const DRY_RUN_OUTPUT = `
Target: https://jsxxgwprxuqgcauzlxcb.supabase.co  (PRODUCTION)
Mode:   dry run (no writes)

Before:
  395_billing_enforcement.sql                 3 stmts  marker: present       W18: trial_ends_at
  397_ai_name_default_null.sql                1 stmts  marker: not probeable comment only
  398_couple_handles_first_seen.sql           4 stmts  marker: absent        Wave 3 contract
  400_deprecate_tangential_pool.sql           0 stmts  marker: not probeable no DDL

Dry run only. Rerun with --apply --allow-prod to write, in this order.
`

describe('parsePendingMigrationsDryRun', () => {
  it('collects only the files whose marker is absent, skipping not-probeable rows', () => {
    const result = parsePendingMigrationsDryRun(DRY_RUN_OUTPUT)
    expect(result.absentFiles).toEqual(['398_couple_handles_first_seen.sql'])
    expect(result.probedCount).toBe(2)
  })

  it('reports no absent files when every probed marker is present', () => {
    const allPresent = DRY_RUN_OUTPUT.replace('marker: absent       ', 'marker: present      ')
    const result = parsePendingMigrationsDryRun(allPresent)
    expect(result.absentFiles).toEqual([])
  })
})
