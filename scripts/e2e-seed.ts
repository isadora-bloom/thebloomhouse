#!/usr/bin/env tsx
/**
 * One script to put the E2E branch into the state the suite expects.
 *
 * E2E-PLAN.md, "Target environment": the Crestwood demo set, plus one
 * real-shaped venue ("Ashcombe Barn", not a demo flag, with
 * `onboarding_completed`), one org_admin, one coordinator, one manager,
 * and one pending couple invitation. "Seeding is one script,
 * `scripts/e2e-seed.ts`, dry by default, refusing production."
 *
 * Usage
 * -----
 *   npx tsx scripts/e2e-seed.ts            # dry run: prints the plan, touches nothing
 *   npx tsx scripts/e2e-seed.ts --apply    # writes, to the branch named by .env.test
 *   E2E_ENV_FILE=.env.branch npx tsx scripts/e2e-seed.ts --apply
 *
 * Safety, in the order the checks fire:
 *
 *   1. The env comes from `E2E_ENV_FILE` (default `.env.test`), never
 *      `.env.local`. Same loader the Playwright harness uses.
 *   2. A `NEXT_PUBLIC_SUPABASE_URL` carrying the production project ref
 *      throws before anything else runs.
 *   3. Without `--apply` no client is built and no statement is sent. A
 *      dry run cannot write by construction, not by discipline.
 *
 * Idempotence: every row this script owns has a deterministic id or a
 * natural key, and is upserted. The composed demo SQL files are applied
 * statement by statement with duplicate-key failures counted and skipped
 * rather than fatal — `supabase/seed.sql` predates ON CONFLICT on its
 * first few inserts, so a second run would otherwise die on the
 * organisation row.
 *
 * The passwords are generated per run and printed once. Re-running resets
 * the three accounts to the newly printed passwords, so the credentials
 * block is always the truth rather than a record of the first run.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { splitSqlStatements } from './lib/sql-split.js'
import { loadE2EEnv, assertNotProduction } from '../e2e/helpers/env'

// ---------------------------------------------------------------------------
// What gets seeded
// ---------------------------------------------------------------------------

/**
 * The demo set, in dependency order. seed.sql builds the org, the four
 * Crestwood venues and their weddings; everything after it hangs off
 * those ids.
 *
 * `supabase/seed-demo-rich.sql` is the committed output of
 * `scripts/seed-demo-rich.ts`. We apply the SQL rather than shelling out
 * to that script on purpose: it loads `.env.local` itself, so it would
 * walk straight past this script's refusal.
 */
const DEMO_SQL_FILES = [
  'supabase/seed.sql',
  'supabase/seed-demo-rich.sql',
  'supabase/seed-marketing-spend-records.sql',
  'supabase/seed-commitments-demo.sql',
  'supabase/seed-contracts-demo.sql',
  'supabase/seed-ad-connections-demo.sql',
] as const

/** Ashcombe Barn: the one venue in the fixture that is not a demo. */
const ASHCOMBE = {
  orgId: 'a5c0b0e0-0000-4000-8000-000000000001',
  orgName: 'Ashcombe Estates',
  venueId: 'a5c0b0e0-0000-4000-8000-000000000010',
  venueName: 'Ashcombe Barn',
  venueSlug: 'ashcombe-barn',
  venuePrefix: 'AB',
  weddingId: 'a5c0b0e0-0000-4000-8000-000000000020',
  inviteId: 'a5c0b0e0-0000-4000-8000-000000000030',
} as const

const ACCOUNTS = [
  { key: 'org_admin', role: 'org_admin', email: 'e2e-orgadmin@ashcombe.test', first: 'Orla', last: 'Admin' },
  { key: 'manager', role: 'venue_manager', email: 'e2e-manager@ashcombe.test', first: 'Martin', last: 'Manager' },
  { key: 'coordinator', role: 'coordinator', email: 'e2e-coordinator@ashcombe.test', first: 'Cora', last: 'Coordinator' },
] as const

/**
 * The couple invitation token. Fixed by default so a spec can hold the
 * plaintext without reading the database, overridable for a run that
 * wants a fresh one. This is a throwaway test branch; the token grants
 * nothing anywhere else.
 */
const COUPLE_INVITE_EMAIL = 'e2e-couple@ashcombe.test'
const COUPLE_INVITE_TOKEN = process.env.E2E_COUPLE_INVITE_TOKEN ?? 'e2e-ashcombe-couple-invite-0001'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function generatePassword(): string {
  // Upper, lower, digit and a symbol, so it clears any policy the
  // auth service applies, plus 18 bytes of entropy.
  return `E2e!${randomBytes(12).toString('base64url')}9a`
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

interface Step {
  name: string
  detail: string[]
  run: (sb: SupabaseClient) => Promise<string>
}

function sqlStep(file: string): Step {
  return {
    name: `Apply ${file}`,
    detail: [`${statementCount(file)} top-level statement(s) via public.exec_sql`],
    run: async (sb) => applySqlFile(sb, file),
  }
}

const statementCache: Record<string, number> = {}
function statementCount(file: string): number | string {
  if (statementCache[file] !== undefined) return statementCache[file]
  try {
    const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
    const n = splitSqlStatements(raw).length
    statementCache[file] = n
    return n
  } catch {
    return 'unreadable'
  }
}

/** Transaction-control statements cannot go through exec_sql. */
const TX_CONTROL_RE = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|END)\b/i

/** Errors that mean "this row is already here", which is a success. */
function isAlreadyThere(state: string | undefined, message: string | undefined): boolean {
  if (state === '23505') return true // unique_violation
  if (state === '42P07') return true // duplicate_table
  if (state === '42710') return true // duplicate_object
  return /already exists|duplicate key/i.test(message ?? '')
}

async function applySqlFile(sb: SupabaseClient, file: string): Promise<string> {
  const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
  const statements = splitSqlStatements(raw).filter((s) => !TX_CONTROL_RE.test(s.trimStart()))
  let ok = 0
  let skipped = 0
  for (const stmt of statements) {
    const { data, error } = await sb.rpc('exec_sql', { sql: stmt })
    if (error) throw new Error(`${file}: RPC transport failed — ${error.message}`)
    const result = data as { ok: boolean; error?: string; state?: string } | null
    if (!result || !result.ok) {
      if (isAlreadyThere(result?.state, result?.error)) {
        skipped++
        continue
      }
      throw new Error(
        `${file}: [${result?.state ?? '?'}] ${result?.error ?? 'unknown'}\n${stmt.slice(0, 400)}`
      )
    }
    ok++
  }
  return `${ok} applied, ${skipped} already present`
}

interface Credential {
  role: string
  email: string
  password: string
}

const credentials: Credential[] = []

async function seedAshcombe(sb: SupabaseClient): Promise<string> {
  const notes: string[] = []

  const { error: orgErr } = await sb
    .from('organisations')
    .upsert({ id: ASHCOMBE.orgId, name: ASHCOMBE.orgName, plan_tier: 'intelligence' }, { onConflict: 'id' })
  if (orgErr) throw new Error(`organisations: ${orgErr.message}`)
  notes.push('org')

  const { error: venueErr } = await sb.from('venues').upsert(
    {
      id: ASHCOMBE.venueId,
      org_id: ASHCOMBE.orgId,
      name: ASHCOMBE.venueName,
      slug: ASHCOMBE.venueSlug,
      plan_tier: 'intelligence',
      status: 'active',
      is_demo: false,
    },
    { onConflict: 'id' }
  )
  if (venueErr) throw new Error(`venues: ${venueErr.message}`)
  notes.push('venue')

  const { error: cfgErr } = await sb.from('venue_config').upsert(
    {
      venue_id: ASHCOMBE.venueId,
      business_name: ASHCOMBE.venueName,
      venue_prefix: ASHCOMBE.venuePrefix,
      onboarding_completed: true,
    },
    { onConflict: 'venue_id' }
  )
  if (cfgErr) throw new Error(`venue_config: ${cfgErr.message}`)
  notes.push('venue_config (onboarding_completed=true)')

  const { error: aiErr } = await sb
    .from('venue_ai_config')
    .upsert({ venue_id: ASHCOMBE.venueId, ai_name: 'Sage' }, { onConflict: 'venue_id' })
  if (aiErr && !/duplicate/i.test(aiErr.message)) notes.push(`venue_ai_config warning: ${aiErr.message}`)

  for (const account of ACCOUNTS) {
    const password = generatePassword()
    const userId = await upsertAuthUser(sb, account.email, password)
    const { error: profErr } = await sb.from('user_profiles').upsert(
      {
        id: userId,
        role: account.role,
        // Org membership is user_profiles.org_id — there is no separate
        // memberships table in this schema.
        org_id: ASHCOMBE.orgId,
        venue_id: ASHCOMBE.venueId,
        first_name: account.first,
        last_name: account.last,
      },
      { onConflict: 'id' }
    )
    if (profErr) throw new Error(`user_profiles (${account.email}): ${profErr.message}`)
    credentials.push({ role: account.role, email: account.email, password })
    notes.push(account.role)
  }

  // A wedding for the invitation to hang off. couple_invites.wedding_id is
  // NOT NULL, so the invitation needs one.
  const { error: wedErr } = await sb.from('weddings').upsert(
    {
      id: ASHCOMBE.weddingId,
      venue_id: ASHCOMBE.venueId,
      status: 'booked',
      wedding_date: '2027-06-12',
      guest_count_estimate: 110,
      booking_value: 21000,
      notes: '[e2e:ashcombe] seeded by scripts/e2e-seed.ts',
    },
    { onConflict: 'id' }
  )
  if (wedErr) throw new Error(`weddings: ${wedErr.message}`)
  notes.push('wedding')

  const { error: invErr } = await sb.from('couple_invites').upsert(
    {
      id: ASHCOMBE.inviteId,
      venue_id: ASHCOMBE.venueId,
      wedding_id: ASHCOMBE.weddingId,
      email: COUPLE_INVITE_EMAIL,
      token_hash: sha256Hex(COUPLE_INVITE_TOKEN),
      expires_at: new Date(Date.now() + 14 * 86400e3).toISOString(),
      used_at: null,
    },
    { onConflict: 'id' }
  )
  if (invErr) throw new Error(`couple_invites: ${invErr.message}`)
  notes.push('pending couple invitation')

  return notes.join(', ')
}

/**
 * Create the auth user, or reset the password of the one already there.
 * Either way the password printed at the end is the one that works.
 */
async function upsertAuthUser(sb: SupabaseClient, email: string, password: string): Promise<string> {
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { seeded_by: 'scripts/e2e-seed.ts' },
  })
  if (!error && data.user) return data.user.id

  if (error && !/already|registered|exists/i.test(error.message)) {
    throw new Error(`auth.createUser (${email}): ${error.message}`)
  }

  const existing = await findAuthUser(sb, email)
  if (!existing) throw new Error(`auth.createUser said ${email} exists but it could not be found`)
  const { error: updErr } = await sb.auth.admin.updateUserById(existing, { password })
  if (updErr) throw new Error(`auth.updateUserById (${email}): ${updErr.message}`)
  return existing
}

async function findAuthUser(sb: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`auth.listUsers: ${error.message}`)
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase())
    if (hit) return hit.id
    if (data.users.length < 200) return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes('--apply')

  const env = loadE2EEnv()
  // Belt and braces: loadE2EEnv has already refused, this says so again
  // with this script named on the line.
  assertNotProduction(env.supabaseUrl, 'scripts/e2e-seed.ts')

  const steps: Step[] = [
    ...DEMO_SQL_FILES.map((f) => sqlStep(f)),
    {
      name: 'Seed Ashcombe Barn',
      detail: [
        `organisation ${ASHCOMBE.orgName} (${ASHCOMBE.orgId})`,
        `venue ${ASHCOMBE.venueName} / ${ASHCOMBE.venueSlug} (${ASHCOMBE.venueId}), is_demo=false`,
        'venue_config.onboarding_completed = true',
        ...ACCOUNTS.map((a) => `${a.role} ${a.email} (auth user + profile + org_id)`),
        `wedding ${ASHCOMBE.weddingId} (2027-06-12, booked)`,
        `pending couple invitation for ${COUPLE_INVITE_EMAIL}, token_hash ${sha256Hex(COUPLE_INVITE_TOKEN).slice(0, 16)}...`,
      ],
      run: seedAshcombe,
    },
  ]

  console.log('')
  console.log('E2E seed')
  console.log('========')
  console.log(`  env file   : ${env.envFile}${env.found ? '' : '  (NOT FOUND)'}`)
  console.log(`  supabase   : ${env.supabaseUrl || '(none)'}`)
  console.log(`  mode       : ${apply ? 'APPLY — this writes' : 'DRY RUN — nothing is written'}`)
  console.log('')

  steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step.name}`)
    for (const d of step.detail) console.log(`       - ${d}`)
  })
  console.log('')

  if (!apply) {
    console.log('  Credentials that WOULD be created (passwords generated at apply time,')
    console.log('  printed once, and reset on every re-run so the print is always current):')
    for (const a of ACCOUNTS) console.log(`       - ${a.role.padEnd(14)} ${a.email}`)
    console.log(`       - couple invite  ${COUPLE_INVITE_EMAIL}  token ${COUPLE_INVITE_TOKEN}`)
    console.log('')
    console.log('  DRY RUN. No client was built and no statement was sent.')
    console.log('  Re-run with --apply to write to the branch above.')
    console.log('')
    return
  }

  if (!env.supabaseUrl || !env.serviceRoleKey) {
    throw new Error(
      `--apply needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${env.envFile}.`
    )
  }

  const sb = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  for (const [i, step] of steps.entries()) {
    const t0 = Date.now()
    process.stdout.write(`  ${i + 1}. ${step.name} ... `)
    const outcome = await step.run(sb)
    console.log(`${outcome} (${Date.now() - t0}ms)`)
  }

  console.log('')
  console.log('  Credentials — printed once, all three reset to these values just now:')
  console.log('')
  for (const c of credentials) {
    console.log(`    ${c.role.padEnd(14)} ${c.email.padEnd(32)} ${c.password}`)
  }
  console.log(`    couple invite  ${COUPLE_INVITE_EMAIL.padEnd(32)} ${COUPLE_INVITE_TOKEN}`)
  console.log('')
  console.log('  Paste into the branch env — section 29 and the journeys read these:')
  console.log('')
  for (const c of credentials) {
    const prefix = c.role === 'venue_manager' ? 'E2E_MANAGER' : `E2E_${c.role.toUpperCase()}`
    console.log(`    ${prefix}_EMAIL=${c.email}`)
    console.log(`    ${prefix}_PASSWORD=${c.password}`)
  }
  console.log(`    E2E_ASHCOMBE_VENUE_ID=${ASHCOMBE.venueId}`)
  console.log(`    E2E_ASHCOMBE_WEDDING_ID=${ASHCOMBE.weddingId}`)
  console.log(`    E2E_COUPLE_INVITE_TOKEN=${COUPLE_INVITE_TOKEN}`)
  console.log('')
  console.log('  Passwords are not stored anywhere else. Lose them and re-run with --apply.')
  console.log('')
}

main().catch((e) => {
  console.error('')
  console.error(`e2e-seed failed: ${e instanceof Error ? e.message : String(e)}`)
  console.error('')
  process.exit(1)
})
