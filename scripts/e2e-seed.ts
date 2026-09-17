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
import { applyReseed, type ReseedWriters } from './demo-reseed/apply'
import { generateDemoDataset, SEED_TODAY } from './demo-reseed/generate'
import { buildReseedPlan } from './demo-reseed/plan'
import { reseedTableRows } from './demo-coverage'
import { validateFiles, formatFindings, loadSeedFacts, SEED_SQL_FILES } from './validate-seed-sql'

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
  'supabase/seed-ad-connections-demo.sql',
  // W70 additions. `seed-reviews.sql` was written for wave 8 and never
  // wired into this list, so the branch would have had no reviews at all
  // and journey 28's "reviews import populates sentiment" step nothing to
  // assert on. `seed-demo-venue-surfaces.sql` carries the team, the
  // invitations, the sending-domain state, benchmark participation and
  // the ad connections — the venue-level rows the reseed cannot write.
  'supabase/seed-reviews.sql',
  'supabase/seed-demo-venue-surfaces.sql',
] as const

/**
 * Left out of the list above on purpose.
 *
 * `supabase/seed-commitments-demo.sql` keys its four rows to wedding
 * 44444444-…-000209, which step 3 deletes and re-mints. Applied before the
 * reseed the rows cascade away; applied after, the wedding id no longer
 * exists and the insert fails the foreign key. The reseed now writes
 * commitments, planning notes and a timeline for every booking, so the
 * table is better covered than that file ever made it. The file stays in
 * the repo for anyone running against a database with the old seed on it.
 */
const DEMO_SQL_FILES_SUPERSEDED: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'supabase/seed-commitments-demo.sql',
    why: 'keyed to a wedding the reseed re-mints; superseded by the reseed aux rows',
  },
]

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

/**
 * One uploaded contract on the Ashcombe wedding, so journey 27's chat can
 * ask about a stored contract by id. Until 2026-09-17 these were two W57
 * signing links; W57 went in favour of ContractHouse, and the old expired
 * row is removed on the next --apply.
 */
const CONTRACT_ID = process.env.E2E_CONTRACT_ID ?? 'a5c0b0e0-0000-4000-8000-000000000040'
const RETIRED_CONTRACT_ID = 'a5c0b0e0-0000-4000-8000-000000000041'

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

// ---------------------------------------------------------------------------
// The reseed
// ---------------------------------------------------------------------------

/**
 * The spine, rebuilt through `linkSignal`.
 *
 * `supabase/seed.sql` writes 72 weddings with fixed 2024-to-2026 dates and
 * no touchpoints at all, which is why the live demo reads Frozen and why
 * every progression-driven surface is blank on it. The reseed clears the
 * four demo venues and replays 60 stories through the real writers, with
 * every date an offset from `SEED_TODAY`. It has to run AFTER the SQL
 * files, because it needs the venues, and because its delete phase would
 * otherwise wipe rows those files had just written.
 */
const RESEED_TODAY = process.env.E2E_SEED_TODAY ?? SEED_TODAY

function reseedDataset() {
  return generateDemoDataset({ today: RESEED_TODAY })
}

/**
 * The real writers, imported only when the run is going to write. The
 * import is dynamic so `loadE2EEnv()` has already put the branch
 * credentials on `process.env` before any module builds a client at
 * import time — the same reason `scripts/demo-reseed.ts` does it this way.
 */
async function liveReseedWriters(): Promise<ReseedWriters> {
  const { linkSignal, mintWedding } = await import('../src/lib/spine/cascade')
  const { mirrorCoupleFromWedding } = await import(
    '../src/lib/services/identity/mirror-couple'
  )
  const { recordEngagementEventsBatch } = await import('../src/lib/services/heat-mapping')
  const { newJudgeBudget } = await import('../src/lib/services/identity/llm-judge')

  return {
    linkSignal: async (args) =>
      linkSignal({
        supabase: args.supabase,
        venueId: args.venueId,
        signal: args.signal,
        bypassCache: true,
        judgeBudget: newJudgeBudget(1),
        source: 'e2e-seed',
      }),
    mintWedding: async (input) =>
      mintWedding({
        venueId: input.venueId,
        source: 'csv_import',
        reason: input.reason,
        supabase: input.supabase,
        signals: input.signals,
      }),
    mirrorCouple: async (input) =>
      mirrorCoupleFromWedding({
        venueId: input.venueId,
        weddingId: input.weddingId,
        supabase: input.supabase,
      }),
    recordHeat: async (venueId, weddingId, events, direction, occurredAt) =>
      recordEngagementEventsBatch(venueId, weddingId, events, direction, occurredAt),
  }
}

async function runReseed(sb: SupabaseClient): Promise<string> {
  const plan = buildReseedPlan(reseedDataset())
  const result = await applyReseed({
    supabase: sb,
    plan,
    dataset: reseedDataset(),
    writers: await liveReseedWriters(),
    dryRun: false,
  })
  if (result.errors.length > 0) {
    throw new Error(
      `reseed reported ${result.errors.length} error(s):\n  ` +
        result.errors.slice(0, 8).join('\n  '),
    )
  }
  const aux = Object.values(result.auxRowsByTable).reduce((s, n) => s + n, 0)
  return (
    `${result.minted} weddings, ${result.mirrored} couples, ` +
    `${result.signalsLinked} signals, ${result.heatEventsWritten} heat events, ` +
    `${aux} mirror rows`
  )
}

/** The per-table plan a dry run prints. */
function reseedPlanLines(): string[] {
  const plan = buildReseedPlan(reseedDataset())
  const byTable = reseedTableRows(plan)
  const names = Object.keys(byTable).sort()
  const width = Math.max(...names.map((n) => n.length))
  return [
    `today ${RESEED_TODAY}, seed ${plan.seed}, ${plan.summary.stories} couples`,
    `${plan.deletes.length} tables cleared first, venue-scoped`,
    ...names.map((n) => `${n.padEnd(width)}  ${String(byTable[n]).padStart(5)}`),
  ]
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
    // W74: migration 215 retired the 3-tier vocabulary this used to say
    // 'intelligence' in; 'growth' is the mapped-forward equivalent.
    // organisations.plan_tier carries no CHECK, so the stale value never
    // failed here, but venues.plan_tier below did — see the CHECK-
    // violation this same migration put on that column.
    .upsert({ id: ASHCOMBE.orgId, name: ASHCOMBE.orgName, plan_tier: 'growth' }, { onConflict: 'id' })
  if (orgErr) throw new Error(`organisations: ${orgErr.message}`)
  notes.push('org')

  const { error: venueErr } = await sb.from('venues').upsert(
    {
      id: ASHCOMBE.venueId,
      org_id: ASHCOMBE.orgId,
      name: ASHCOMBE.venueName,
      slug: ASHCOMBE.venueSlug,
      // W74: 'intelligence' is pre-migration-215 vocabulary. venues has a
      // CHECK on plan_tier (pre_opening | solo | growth | multi |
      // enterprise) — this was the statement that actually failed
      // 23514 on the test branch, the seed SQL findings came after it.
      plan_tier: 'growth',
      status: 'active',
      is_demo: false,
      // A real place, so anything keyed on location (weather, climate
      // norms, the DC-proxy radius) has something to work with.
      // Charlottesville, VA.
      city: 'Charlottesville',
      state: 'VA',
      latitude: 38.0293,
      longitude: -78.4767,
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
    // Keep the password the env file already holds. The seed used to
    // mint a fresh one on every --apply, so each re-run silently broke
    // every platform login in .env.test until the operator re-pasted
    // the print-out; on 2026-09-15 four re-seeds in one afternoon did
    // exactly that to sections 26, 28, 29 and 30. A password is only
    // generated when the env has none.
    const envKey = account.role === 'venue_manager' ? 'E2E_MANAGER_PASSWORD' : `E2E_${account.role.toUpperCase()}_PASSWORD`
    const fromEnv = process.env[envKey]?.trim()
    const password = fromEnv && fromEnv.length >= 12 ? fromEnv : generatePassword()
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

  // Two tables, so the seating page mounts the board (§27 "the seating
  // page renders the board"). With no seating_tables row the page shows
  // its own "No tables yet" card and the board, with the two test ids
  // the journey asserts, never renders. Fixed ids: the upsert is a no-op
  // on a re-seed.
  const { error: tablesErr } = await sb.from('seating_tables').upsert(
    [
      {
        id: 'a5c0b0e0-0000-4000-8000-000000000040',
        venue_id: ASHCOMBE.venueId,
        wedding_id: ASHCOMBE.weddingId,
        table_name: 'Table 1',
        table_type: 'round',
        capacity: 8,
        sort_order: 1,
      },
      {
        id: 'a5c0b0e0-0000-4000-8000-000000000041',
        venue_id: ASHCOMBE.venueId,
        wedding_id: ASHCOMBE.weddingId,
        table_name: 'Table 2',
        table_type: 'round',
        capacity: 8,
        sort_order: 2,
      },
    ],
    { onConflict: 'id' }
  )
  if (tablesErr) throw new Error(`seating_tables: ${tablesErr.message}`)
  notes.push('two seating tables')

  // One real row in every couple-portal section table (the same list the
  // sidebar counts in src/lib/services/couple/section-status.ts), so each
  // page renders its populated state rather than an empty card, and the
  // sidebar has amber sections to show. Added 2026-09-15 after the seating
  // journey found the seed only carried what the first journeys asked
  // for. Column names and CHECK vocabularies come from the migrations via
  // scripts/demo-reseed/schema-facts; the seed validator (W74) keeps them
  // honest. Fixed ids from ...0042 upwards; every upsert is a no-op on a
  // re-seed. Not seeded: contracts (the signing fixtures below own that
  // table) and borrow_selections (needs a catalog row this venue does not
  // have).
  const fid = (n: number) => `a5c0b0e0-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
  const scoped = { venue_id: ASHCOMBE.venueId, wedding_id: ASHCOMBE.weddingId }
  const portalRows: Array<[string, Record<string, unknown>[]]> = [
    ['wedding_details', [{ id: fid(42), ...scoped, ceremony_location: 'outside', wedding_party_count: 6 }]],
    ['budget_items', [
      { id: fid(43), ...scoped, category: 'Venue', item_name: 'Full day hire', budgeted: 21000, committed: 21000, paid: 5000, sort_order: 1 },
      { id: fid(44), ...scoped, category: 'Flowers', item_name: 'Ceremony arch and tables', budgeted: 2400, committed: 0, paid: 0, sort_order: 2 },
    ]],
    ['timeline', [
      { id: fid(45), ...scoped, time: '14:00', duration_minutes: 30, title: 'Ceremony', category: 'ceremony', sort_order: 1 },
      { id: fid(46), ...scoped, time: '18:00', duration_minutes: 90, title: 'Dinner', category: 'reception', sort_order: 2 },
    ]],
    ['ceremony_order', [{ id: fid(47), ...scoped, participant_name: 'Officiant', role: 'officiant', sort_order: 1 }]],
    ['rehearsal_dinner', [{ id: fid(48), ...scoped, location_name: 'The Old Mill', date: '2027-06-11', start_time: '18:30', guest_count: 24 }]],
    ['booked_vendors', [{ id: fid(49), ...scoped, vendor_type: 'photographer', vendor_name: 'Ashcombe Light Photography', is_booked: true }]],
    ['bar_planning', [{ id: fid(50), ...scoped, bar_type: 'beer_wine', guest_count: 110, bartender_count: 2 }]],
    ['makeup_schedule', [{ id: fid(51), ...scoped, person_name: 'Partner one', role: 'partner', hair_time: '09:00', makeup_time: '10:00', sort_order: 1 }]],
    ['decor_inventory', [{ id: fid(52), ...scoped, item_name: 'Brass lanterns', category: 'tables', quantity: 12, source: 'personal' }]],
    ['photo_library', [{ id: fid(53), ...scoped, image_url: 'https://placehold.co/1200x800/e8e4dc/6b6b6b?text=Ashcombe+Barn', caption: 'The barn at golden hour', is_website: true }]],
    ['shuttle_schedule', [{ id: fid(54), ...scoped, route_name: 'Hotel to barn', pickup_location: 'The Ashcombe Inn', dropoff_location: 'Ashcombe Barn', pickup_time: '13:00', seat_count: 30, sort_order: 1 }]],
    ['staffing_assignments', [{ id: fid(55), ...scoped, role: 'bartender', count: 2, hours: 6 }]],
    ['guest_list', [
      { id: fid(56), ...scoped, first_name: 'Ada', last_name: 'Wren', email: 'ada.wren@example.test', rsvp_status: 'attending', group_name: 'Family' },
      { id: fid(57), ...scoped, first_name: 'Ben', last_name: 'Okafor', email: 'ben.okafor@example.test', rsvp_status: 'attending', group_name: 'Friends', has_plus_one: true, plus_one_name: 'Sam Okafor' },
      { id: fid(58), ...scoped, first_name: 'Cleo', last_name: 'Hart', email: 'cleo.hart@example.test', rsvp_status: 'pending', group_name: 'Work' },
      { id: fid(59), ...scoped, first_name: 'Dev', last_name: 'Patel', email: 'dev.patel@example.test', rsvp_status: 'declined', group_name: 'Friends' },
    ]],
    ['rsvp_config', [{ id: fid(60), ...scoped, ask_meal_choice: true, ask_dietary: true, rsvp_deadline: '2027-05-01' }]],
    ['wedding_party', [{ id: fid(61), ...scoped, name: 'Ada Wren', role: 'Maid of honour', side: 'partner1', sort_order: 1 }]],
    ['allergy_registry', [{ id: fid(62), ...scoped, guest_name: 'Cleo Hart', allergy_type: 'Tree nuts', severity: 'severe', is_important: true }]],
    ['guest_care_notes', [{ id: fid(63), ...scoped, guest_name: 'Ada Wren', care_type: 'mobility', note: 'Aisle seat, near the exit.' }]],
    // guests is text[] (migration 009), the only array column in this fill.
    ['bedroom_assignments', [{ id: fid(64), ...scoped, room_name: 'The Hayloft', guests: ['Ada Wren'], notes: 'Ground floor requested.' }]],
    ['table_map_layouts', [{ id: fid(65), wedding_id: ASHCOMBE.weddingId, elements: [] }]],
    ['wedding_tables', [{ id: fid(66), ...scoped, guest_count: 110, table_shape: 'round', guests_per_table: 8, linen_color: 'ivory', is_draft: false }]],
    ['wedding_worksheets', [{ id: fid(67), ...scoped, section: 'priorities', content: 'Food, then music, then flowers.' }]],
    ['wedding_website_settings', [{ id: fid(68), ...scoped, slug: 'ashcombe-e2e-couple', is_published: false, theme: 'classic', couple_names: 'The E2E Couple', partner1_name: 'Partner One', partner2_name: 'Partner Two', venue_name: ASHCOMBE.venueName, wedding_date: '2027-06-12' }]],
  ]
  for (const [table, rows] of portalRows) {
    const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' })
    if (error) throw new Error(`${table}: ${error.message}`)
  }
  notes.push(`${portalRows.length} couple-portal section tables filled`)

  // The spine. Every couple-facing read that matters goes through the
  // couples row, not the legacy weddings row: the day-outlook card takes
  // the wedding date from it, the register route checks the couple's
  // addresses on it, and a wedding with no couples row is exactly the
  // legacy shape the identity doctrine retired. Written through the
  // real mirror writer (the same one mintWedding calls), never a direct
  // insert, so the seed stays inside the one-writer rule. Imported
  // dynamically for the same reason liveReseedWriters is: the branch
  // credentials have to be on process.env before the module builds a
  // client.
  const { mirrorCoupleFromWedding } = await import('../src/lib/services/identity/mirror-couple')
  const mirrored = await mirrorCoupleFromWedding({
    venueId: ASHCOMBE.venueId,
    weddingId: ASHCOMBE.weddingId,
    supabase: sb,
    correlationId: 'e2e-seed:ashcombe',
  })
  if (!mirrored.coupleId) throw new Error('couples: mirrorCoupleFromWedding wrote no row for the Ashcombe wedding')
  notes.push('couples row (spine mirror)')

  // Climate norms for the wedding month, so the couple's day-outlook card
  // has its "typical" mode (the forecast mode needs a date inside 14
  // days, which a seeded wedding never is). Production fills this table
  // from a decade of Open-Meteo history via the climate-norms backfill;
  // the values here are plausible for Charlottesville in June and are
  // fixture data, not something a journey asserts on. Keyed on
  // (venue_id, month_num, hour_local), so a re-seed rewrites in place.
  const weddingMonth = 6
  const normRows = Array.from({ length: 24 }, (_, hour) => {
    const daytime = hour >= 10 && hour <= 20
    return {
      venue_id: ASHCOMBE.venueId,
      month_num: weddingMonth,
      hour_local: hour,
      recent_temp_avg_f: daytime ? 82 : 66,
      recent_temp_p10_f: daytime ? 72 : 58,
      recent_temp_p90_f: daytime ? 91 : 73,
      recent_precip_avg_in: 0.14,
      recent_precip_prob_pct: daytime ? 28 : 18,
      recent_sample_count: 300,
      prior_temp_avg_f: daytime ? 80 : 64,
      prior_precip_avg_in: 0.12,
      prior_precip_prob_pct: daytime ? 25 : 16,
      prior_sample_count: 300,
      recent_window_start: '2016-01-01',
      recent_window_end: '2025-12-31',
      prior_window_start: '2006-01-01',
      prior_window_end: '2015-12-31',
    }
  })
  const { error: normsErr } = await sb
    .from('weather_climate_norms')
    .upsert(normRows, { onConflict: 'venue_id,month_num,hour_local' })
  if (normsErr) throw new Error(`weather_climate_norms: ${normsErr.message}`)
  notes.push('June climate norms')

  // Three recent inquiries, through the real writer. /today's "since you
  // were last here" strip is a spine-only reader (couples, touchpoints,
  // drafts, admin_notifications) and renders its all-zero state on a
  // venue with nothing in the window, which is what §26 hit on a fresh
  // Ashcombe (2026-09-15). linkSignal is the one writer for the spine
  // (identity doctrine), so the inquiries are linked exactly as an
  // inbound email would be, never inserted. Three keeps Ashcombe well
  // under the 25-couple floor §28's not-enough-data refusal depends on.
  // Fixed external ids: linkSignal dedupes on them, so a re-seed is a
  // no-op here too. Vocabulary mirrors scripts/demo-reseed/generate.ts:
  // a gmail inquiry is channel 'gmail', action 'reply', tier 'high'.
  const { linkSignal } = await import('../src/lib/spine/cascade')
  const { emailToNormalizedSignal } = await import('../src/lib/services/identity/email-to-signal')
  const inquiries = [
    { key: 'e2e-ashcombe-inquiry-0001', name: 'Nora Bell', email: 'nora.bell@example.test', daysAgo: 2, body: 'Hi! We are looking at June 2027 for around 120 guests. Is the barn available, and what does a full day cost?' },
    { key: 'e2e-ashcombe-inquiry-0002', name: 'Theo Marsh', email: 'theo.marsh@example.test', daysAgo: 1, body: 'We visited a friend\'s wedding at Ashcombe last summer and loved it. Could we book a tour for a Saturday in October?' },
    { key: 'e2e-ashcombe-inquiry-0003', name: 'Priya Lang', email: 'priya.lang@example.test', daysAgo: 0, body: 'Do you allow outside caterers? We have a family cook we would love to use. Around 80 guests, spring 2028.' },
  ]
  let linked = 0
  for (const q of inquiries) {
    const occurredAt = new Date(Date.now() - q.daysAgo * 86400e3 - 90 * 60e3).toISOString()
    const base = emailToNormalizedSignal({
      email: { messageId: q.key, threadId: q.key, subject: `${q.name} — wedding inquiry` },
      interactionId: q.key,
      emailDate: occurredAt,
      rawFromName: q.name,
      rawFromEmail: q.email,
      signalTier: 'high',
      resolvedEmail: q.email,
      resolvedName: q.name,
      channelOverride: 'gmail',
      actionTypeOverride: 'reply',
      fullBody: q.body,
    })
    const result = await linkSignal({
      supabase: sb,
      venueId: ASHCOMBE.venueId,
      signal: { ...base, author_class: 'couple', raw_payload: { ...base.raw_payload, e2e_seed: true, direction: 'inbound' } },
      bypassCache: true,
      source: 'e2e-seed',
    })
    if (!result.duplicate) linked++
  }
  notes.push(`${linked} new inquiries linked (${inquiries.length - linked} already there)`)

  // Portal section config, through the same writer the section-config
  // route uses on first read. Without rows the coordinator's section
  // settings and the wedding portal preview are both empty (§26,
  // 2026-09-15); with them the preview renders one accordion per section.
  const { ensurePortalSectionConfig } = await import('../src/lib/services/portal/section-defaults')
  const sectionsWritten = await ensurePortalSectionConfig(sb, ASHCOMBE.venueId)
  notes.push(sectionsWritten > 0 ? `${sectionsWritten} portal sections` : 'portal sections already there')

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

  await seedContract(sb)
  notes.push('one uploaded contract')

  return notes.join(', ')
}

/** The uploaded contract journey 27's chat asks about. */
async function seedContract(sb: SupabaseClient): Promise<void> {
  const { error: retireErr } = await sb.from('contracts').delete().eq('id', RETIRED_CONTRACT_ID)
  if (retireErr) throw new Error(`contracts (retire): ${retireErr.message}`)

  const { error } = await sb.from('contracts').upsert(
    [
      {
        id: CONTRACT_ID,
        venue_id: ASHCOMBE.venueId,
        wedding_id: ASHCOMBE.weddingId,
        filename: 'e2e-venue-agreement.pdf',
        kind: 'uploaded',
        status: 'extracted',
        template_key: null,
        generated_from: null,
        sign_token: null,
        sent_at: null,
        viewed_at: null,
        signed_at: null,
        signed_name: null,
        extracted_text:
          'Venue hire agreement. Full day hire for 110 guests. Total 21,000 USD, deposit 5,250 USD due on signing, balance 30 days before the wedding.',
      },
    ],
    { onConflict: 'id' }
  )
  if (error) throw new Error(`contracts: ${error.message}`)
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
  const skipReseed = process.argv.includes('--skip-reseed')

  const env = loadE2EEnv()
  // Belt and braces: loadE2EEnv has already refused, this says so again
  // with this script named on the line.
  assertNotProduction(env.supabaseUrl, 'scripts/e2e-seed.ts')

  // W74: validate the seed SQL against the migrations before building or
  // printing the plan — dry run and apply alike. `supabase/seed.sql`
  // inserting `venues.plan_tier = 'intelligence'` (migration 215 retired
  // it) reached `--apply` and died on its first statement; a second pass
  // found `interactions` rows missing the NOT NULL `signal_class`
  // (migration 192) right behind it. Same class of bug `demo-reseed/
  // validate-plan.ts` already catches for the generated reseed rows —
  // this is that check for the hand-written files.
  //
  // W75: with the env file to hand, the validator also reads the live
  // CHECK constraints from the branch (read-only probe through exec_sql)
  // and merges them over the migration-derived facts. Migration 411's
  // `format()`-built regex CHECKs are the reason: the text reader cannot
  // see them and the seed died on one at --apply. Dry run and apply both
  // pay for the read; a missing env file falls back to offline facts
  // with a warning, but a present env whose read fails is fatal.
  const liveEnvFile = env.found && env.supabaseUrl && env.serviceRoleKey ? env.envPath : null
  if (!liveEnvFile) {
    console.warn(
      `[e2e-seed] ${env.envFile} has no Supabase credentials; validating against migration text only ` +
        '(live CHECK constraints, e.g. migration 411 regex shapes, are not checked).',
    )
  }
  const loaded = await loadSeedFacts(liveEnvFile)
  if (loaded.notes.length > 0) {
    console.log('[e2e-seed] seed validation notes:')
    for (const n of loaded.notes) console.log(`  - ${n}`)
  }
  const seedFindings = validateFiles(SEED_SQL_FILES, loaded.facts)
  if (seedFindings.length > 0) {
    console.error('')
    console.error(formatFindings(seedFindings))
    console.error('')
    throw new Error(
      `seed SQL failed validation (${seedFindings.length} finding(s)) — run ` +
        `\`npm run check:seed-sql\` for the full list. Refusing to ${apply ? 'apply' : 'plan'}.`,
    )
  }

  // Ashcombe before the reseed. Every journey depends on Ashcombe; only
  // §28's populated-venue half depends on the reseed, and the reseed is
  // the long, network-heavy step: on 2026-09-15 it failed twice on a
  // flaky link ("TypeError: fetch failed") and Ashcombe, which came
  // after it, was never written at all. The two are independent (the
  // reseed deletes only the four demo venues' rows), so the part the
  // suite cannot run without goes first. --skip-reseed leaves the demo
  // venues as they are for a quick Ashcombe-only pass.
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
        `contract ${CONTRACT_ID}, uploaded, for journey 27's chat`,
      ],
      run: seedAshcombe,
    },
    ...(skipReseed
      ? []
      : [
          {
            name: 'Reseed the Crestwood spine through linkSignal',
            detail: reseedPlanLines(),
            run: runReseed,
          },
        ]),
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
  for (const s of DEMO_SQL_FILES_SUPERSEDED) {
    console.log(`  not applied: ${s.file}`)
    console.log(`       ${s.why}`)
  }
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
  console.log(`    E2E_ASHCOMBE_SLUG=${ASHCOMBE.venueSlug}`)
  console.log(`    E2E_COUPLE_INVITE_EMAIL=${COUPLE_INVITE_EMAIL}`)
  console.log(`    E2E_COUPLE_INVITE_TOKEN=${COUPLE_INVITE_TOKEN}`)
  console.log(`    E2E_CONTRACT_ID=${CONTRACT_ID}`)
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
