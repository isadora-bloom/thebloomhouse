/**
 * Apply every migration owed to production, in order, in one sitting.
 *
 * Why this exists (2026-09-11): waves 2 to 4 of NOVEMBER-PLAN.md each added
 * migrations and none were applied between waves, on purpose. Agents never
 * write to the database, and the operator should not have to run seven
 * commands and remember the order. This runner holds the order.
 *
 * Usage:
 *   npx tsx scripts/apply-pending-migrations.ts                    dry run
 *   npx tsx scripts/apply-pending-migrations.ts --apply --allow-prod
 *   npx tsx scripts/apply-pending-migrations.ts --env .env.test --apply   # golden-case branch
 *   npx tsx scripts/apply-pending-migrations.ts --include-legacy ...  also the older six
 *   npx tsx scripts/apply-pending-migrations.ts --from 399 ...        resume after a failure
 *
 * The dry run reads the files, counts statements, and probes production
 * (read only) for a marker each migration leaves behind, so you can see
 * what is already there before writing anything. `--apply` runs each file
 * through scripts/run-migration.ts (the exec_sql runner every prior
 * migration used), stops on the first failure, asks PostgREST to reload
 * its schema cache, then re-probes and prints a verification table.
 *
 * Every file in the list is idempotent, so a rerun after a failure is safe.
 * 308 is deliberately absent: it creates storage policies, which exec_sql
 * cannot ("must be owner of table objects"); it needs the SQL editor.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { splitSqlStatements } from './lib/sql-split.js'

interface Pending {
  file: string
  why: string
  /** Read-only probe: true = marker present, false = absent, null = not probeable. */
  probe?: (sb: SupabaseClient) => Promise<boolean | null>
}

const columnExists = (table: string, column: string) => async (sb: SupabaseClient) => {
  const { error } = await sb.from(table).select(column).limit(1)
  if (!error) return true
  if (error.code === '42703' || /column .* does not exist/i.test(error.message)) return false
  if (error.code === 'PGRST205' || error.code === '42P01' || /relation .* does not exist|Could not find the table/i.test(error.message)) return false
  return null
}

// A HEAD request through supabase-js reports no error for a missing table,
// so this is a real (tiny) select. PGRST205 is PostgREST's "no such table".
const tableExists = (table: string) => async (sb: SupabaseClient) => {
  const { error } = await sb.from(table).select('*').limit(1)
  if (!error) return true
  if (error.code === 'PGRST205' || error.code === '42P01' || /relation .* does not exist|Could not find the table/i.test(error.message)) return false
  return null
}

/** Owed since wave 2. Order matters only where noted; all are idempotent. */
const WAVE_MIGRATIONS: Pending[] = [
  {
    file: '395_billing_enforcement.sql',
    why: 'W18: venues.trial_ends_at so a venue with no card is on a real trial, not a free solo tier',
    probe: columnExists('venues', 'trial_ends_at'),
  },
  {
    file: '397_ai_name_default_null.sql',
    why: "W16 root cause: venue_ai_config.ai_name no longer defaults to 'Sage'",
  },
  {
    file: '398_couple_handles_first_seen.sql',
    why: 'Wave 3 contract: couples.handles, couples.first_seen_at, fragments.handles',
    probe: columnExists('couples', 'handles'),
  },
  {
    file: '399_social_engagements_couple_id.sql',
    why: 'W23: social captures bind to the spine (couple_id), not to people',
    probe: columnExists('social_engagements', 'couple_id'),
  },
  {
    file: '400_deprecate_tangential_pool.sql',
    why: 'W24: comments marking tangential_signals and client_match_queue retired (no DDL)',
  },
  {
    file: '401_instagram_connections.sql',
    why: 'W28: per-venue Instagram business connection for the DM webhook',
    probe: tableExists('instagram_connections'),
  },
  {
    file: '402_merge_couples_handles.sql',
    why: 'W22: merge_couples carries handles and records a handle contradiction (after 398)',
  },
  {
    file: '403_venue_config_social_handles.sql',
    why: 'W36: the venue\x27s own social handles, excluded from stamping on couples',
    probe: columnExists('venue_config', 'social_handles'),
  },
  {
    file: '404_weather_alerts.sql',
    why: 'W49: weather_alerts (NWS severity feed) and weather_climate_annual (per-year normals for the trend)',
    probe: tableExists('weather_alerts'),
  },
  {
    file: '406_commitment_reconciliation.sql',
    why: 'W50: what a couple told the venue that has no event on their running order; planning_notes.source_interaction_id; timeline.config_json declared',
    probe: tableExists('commitment_reconciliation'),
  },
  {
    file: '407_ad_connections.sql',
    why: 'W54: meta_ads_connections + tiktok_ads_connections (per-venue ad account tokens), and last_synced_at on google_ads_connections. NOTE 310 must land first, it creates google_ads_connections and is in the legacy list below',
    probe: tableExists('meta_ads_connections'),
  },
  {
    file: '408_venue_sending_domain.sql',
    why: 'W55: per-venue Resend sending domain and its verification status on venue_config',
    probe: columnExists('venue_config', 'sending_domain'),
  },
  {
    file: '409_contract_generation.sql',
    why: 'W57: generated contracts on the contracts table (kind, status trail, sign token hash, generated_from snapshot)',
    probe: columnExists('contracts', 'sign_token'),
  },
  {
    file: '410_benchmark_participation.sql',
    why: 'W56 follow-up: cross-venue benchmark participation is opt-in, default off (doctrine INV-24.1-A)',
    probe: columnExists('venue_config', 'benchmark_participation'),
  },
  {
    file: '411_security_policies.sql',
    why: 'S3 (2026-09-14 security audit): folder-scoped storage policies, token column grants, demo-anon reach into credentials, env-var-name indirection, twilio number uniqueness, hashed invite and vendor tokens, venue_config writes gated on role. STEPS 1 and 2 touch the storage schema and may report "must be owner of table objects" through exec_sql, like 308; they raise a WARNING and the rest still applies. Run `node scripts/check-live-policies.mjs` after, and if the storage lines still read NEEDS 411, paste those two steps into the SQL editor',
    probe: tableExists('twilio_number_claims'),
  },
  {
    file: '412_tangential_comment.sql',
    why: "W68: corrects 400's tangential_signals comment, which claimed 'no new rows' while four adapters were still inserting. Comment only, no DDL, so there is nothing to probe for",
  },
  {
    file: '413_venue_config_token_columns_authenticated.sql',
    why: '411 follow-up: the three venue_config token columns were still SELECTable by authenticated',
  },
  {
    file: '414_auth_users_seed_null_tokens.sql',
    why: 'Seeded auth.users rows carried NULL in the token and metadata columns GoTrue scans as non-null, so auth.admin.listUsers failed past page size 10 on production and the e2e project, and findAuthUserByEmail always returned null. Data repair only, idempotent, no DDL to probe for. Already applied by hand to the e2e project on 2026-09-15',
  },
  {
    file: '415_policies_reading_auth_users.sql',
    why: 'Seven policies from 030/031/243 selected from auth.users inside their predicate; authenticated cannot read that table, so the predicate errored and PostgREST answered 403 to EVERY authenticated query on ceremony_chair_plans, table_map_layouts and the brand_assets couple read (§27 journey, 2026-09-15). Replaced with can_access_wedding / couple_user_wedding_id. check-live-policies reports any policy mentioning auth.users',
  },
  {
    file: '416_portal_section_config_defaults.sql',
    why: 'Every venue with no portal_section_config rows gets the 32 defaults (the demo seed was the only writer, so section settings and the portal preview were empty for every real venue, §26 2026-09-15). Same values as src/lib/services/portal/section-defaults.ts, which the section-config route applies on first read from now on',
  },
]

/** Never applied to production (found by W11's schema-truth check). */
const LEGACY_MIGRATIONS: Pending[] = [
  { file: '291_channel_intel_snapshots.sql', why: 'channel_intel_snapshots table', probe: tableExists('channel_intel_snapshots') },
  { file: '304_marketing_agencies.sql', why: 'marketing agencies suite', probe: tableExists('marketing_agencies') },
  { file: '305_agency_spend_channel_linkage.sql', why: 'agency spend to channel linkage' },
  { file: '307_agency_profile_depth.sql', why: 'agency profile depth (documents, contacts, engagements)' },
  { file: '309_web_pixel.sql', why: 'web_visits for the marketing-site pixel', probe: tableExists('web_visits') },
  { file: '310_google_ads_and_downloads_audit.sql', why: 'google_ads tables and downloads audit' },
]

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync(process.env.MIGRATION_ENV_FILE ?? '.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '').replace(/\r$/, '')
    }
  } catch {
    // no .env.local; process.env must carry the keys
  }
  return env
}

function statementCount(file: string): number {
  const sql = readFileSync(resolve('supabase/migrations', file), 'utf8')
  return splitSqlStatements(sql).filter((s) => !/^\s*(BEGIN|COMMIT|END)\b/i.test(s)).length
}

function fmtProbe(v: boolean | null | undefined): string {
  if (v === true) return 'present'
  if (v === false) return 'absent'
  return 'not probeable'
}

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const allowProd = argv.includes('--allow-prod')
  const includeLegacy = argv.includes('--include-legacy')
  const fromIdx = argv.indexOf('--from')
  const from = fromIdx >= 0 ? argv[fromIdx + 1] ?? '' : ''

  // --env <path> (not --env-file: Node owns that flag and would swallow a bad
  // path before this script's guards ran) points both this runner and the spawned run-migration.ts
  // at another env file, e.g. .env.test for the golden-case branch. The
  // production guard below is by URL, so it still applies whichever file is used.
  const envIdx = argv.indexOf('--env')
  if (envIdx >= 0 && argv[envIdx + 1]) process.env.MIGRATION_ENV_FILE = argv[envIdx + 1]

  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (from the env file, default .env.local).')
    process.exit(2)
  }
  const isProd = /jsxxgwprxuqgcauzlxcb/.test(url)
  if (apply && isProd && !allowProd) {
    console.error('Target is production. Add --allow-prod to write, or drop --apply for a dry run.')
    process.exit(2)
  }

  const list = [...WAVE_MIGRATIONS, ...(includeLegacy ? LEGACY_MIGRATIONS : [])].filter(
    (m) => !from || m.file.localeCompare(from) >= 0,
  )
  const sb = createClient(url, key, { auth: { persistSession: false } })

  console.log(`\nTarget: ${url}${isProd ? '  (PRODUCTION)' : ''}`)
  console.log(`Mode:   ${apply ? 'APPLY' : 'dry run (no writes)'}\n`)

  console.log('Before:')
  const before = new Map<string, boolean | null>()
  for (const m of list) {
    const probe = m.probe ? await m.probe(sb) : null
    before.set(m.file, probe)
    console.log(`  ${m.file.padEnd(44)} ${String(statementCount(m.file)).padStart(3)} stmts  marker: ${fmtProbe(probe).padEnd(13)} ${m.why}`)
  }

  if (!apply) {
    console.log('\nDry run only. Rerun with --apply --allow-prod to write, in this order.')
    return
  }

  console.log('\nApplying:')
  const applied: string[] = []
  for (const m of list) {
    const path = `supabase/migrations/${m.file}`
    console.log(`\n=== ${m.file}`)
    const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/run-migration.ts', path], {
      stdio: 'inherit',
      env: process.env,
    })
    if (r.status !== 0) {
      console.error(`\nStopped at ${m.file} (exit ${r.status}). Applied so far: ${applied.join(', ') || 'none'}.`)
      console.error(`Fix the failing statement, then resume with: --apply --allow-prod --from ${m.file}`)
      process.exit(1)
    }
    applied.push(m.file)
  }

  // PostgREST caches the schema; a new table or column is invisible to the
  // API until it reloads. NOTIFY is the documented way to ask.
  await sb.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema'" })
  await new Promise((r) => setTimeout(r, 2500))

  console.log('\nAfter:')
  let unverified = 0
  for (const m of list) {
    const probe = m.probe ? await m.probe(sb) : null
    const was = before.get(m.file)
    const mark = probe === true ? 'ok' : probe === false ? 'STILL ABSENT' : 'applied (no probe)'
    if (probe === false) unverified++
    console.log(`  ${m.file.padEnd(44)} ${mark}${was === true && probe === true ? ' (was already present)' : ''}`)
  }
  console.log(`\nDone. ${applied.length}/${list.length} applied${unverified ? `, ${unverified} marker(s) still absent, look at the output above` : ''}.`)
  if (unverified) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
