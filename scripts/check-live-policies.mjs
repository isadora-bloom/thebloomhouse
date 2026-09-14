#!/usr/bin/env node
/**
 * Print the live security posture of everything migration 411 touches,
 * and mark each line against what 411 expects. READ ONLY. Run it before
 * the operator applies 411 and again afterwards; the lines that say
 * `NEEDS 411` are the ones that should flip to `OK`.
 *
 * Usage:
 *   node scripts/check-live-policies.mjs
 *   node scripts/check-live-policies.mjs --env ../../.env.local
 *   node scripts/check-live-policies.mjs --json
 *
 * Exit code is always 0. This is a report, not a gate. The gate is
 * scripts/check-storage-policies-scoped.mjs, which is static and runs in
 * CI; this one needs production credentials and a human reading it.
 *
 * WHY IT READS THE WAY IT DOES
 * ----------------------------
 * There is no DATABASE_URL on this workstation and PostgREST does not
 * expose pg_catalog, so `pg_policies` cannot be selected over the REST
 * API. What does exist is `public.exec_sql` (migration 198), a
 * service-role-only RPC that runs one statement and returns
 * {ok, error, state} rather than rows. So a read goes out as a DO block
 * that SELECTs into a variable and then deliberately raises, and the
 * answer comes back in the error message. It looks odd and it is worth
 * saying plainly: the only thing this script ever executes is a SELECT
 * inside a block that always aborts. Nothing is written. Bucket flags
 * come from the Storage REST API, which is a plain GET.
 *
 * Secrets are never printed. Policy names, role names, column names and
 * boolean flags only.
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
// --raw prints each probe's payload verbatim before the report. Use it
// when a section reads UNKNOWN or suspiciously empty: an empty answer and
// a refused answer look the same in the summary, and they are not the
// same thing.
const RAW = argv.includes('--raw')
const envIdx = argv.indexOf('--env')
const ENV_PATH = envIdx >= 0 ? argv[envIdx + 1] : '.env.local'

function loadEnv(path) {
  const out = { ...process.env }
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '').replace(/\r$/, '')
    }
  } catch {
    // no file; process.env must carry the keys
  }
  return out
}

const env = loadEnv(ENV_PATH)
const BASE = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

if (!BASE || !KEY) {
  console.log(
    'check-live-policies: no Supabase URL / service-role key found '
      + `(looked in ${ENV_PATH} and process.env). Nothing to read; skipping.`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

/**
 * Run a read-only SELECT and get its text back. The statement is wrapped
 * in a DO block that assigns into a variable and then raises, because
 * exec_sql returns {ok, error} and not rows. Nothing is written.
 */
async function readScalar(label, selectExpr) {
  const sql = `DO $probe$ DECLARE r text; BEGIN ${selectExpr} RAISE EXCEPTION 'CLPR:%', coalesce(r, ''); END $probe$;`
  const res = await fetch(`${BASE}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql }),
  })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const body = await res.json()
  let out
  if (body && body.ok === false && typeof body.error === 'string') {
    const m = body.error.match(/CLPR:([\s\S]*)$/)
    out = m ? { value: m[1] } : { error: body.error }
  } else {
    out = { error: 'exec_sql returned no probe payload (is migration 198 applied?)' }
  }
  if (RAW) {
    console.log(`--- raw: ${label} ---`)
    console.log(out.error ? `ERROR ${out.error}` : (out.value || '(empty)'))
    console.log('')
  }
  return out
}

async function listBuckets() {
  const res = await fetch(`${BASE}/storage/v1/bucket`, { headers })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const body = await res.json()
  if (!Array.isArray(body)) return { error: JSON.stringify(body).slice(0, 200) }
  return { value: body }
}

// ---------------------------------------------------------------------------
// What 411 expects
// ---------------------------------------------------------------------------

/** Buckets: the public flag 411 leaves them on, and why. */
const BUCKETS = [
  ['contracts', false, 'signed URLs only (generate.ts, contract-library.tsx)'],
  ['vendor-contracts', false, 'signed URLs only (_couple-pages/vendors)'],
  ['day-of-media', false, 'coordinator media; anon read dropped'],
  ['brain-dump', false, 'already private (084)'],
  ['crm-imports', false, 'already private (270)'],
  ['couple-photos', true, 'public wedding website renders these'],
  ['inspo-gallery', true, 'public URLs persisted in inspo_gallery.image_url'],
  ['venue-assets', true, 'logos and floor plans render by public URL'],
]

/** The nine buckets whose storage.objects policies 411 rewrites. */
const SCOPED_BUCKETS = BUCKETS.map((b) => b[0])

/**
 * Table policies 411 removes. Each is a leak on its own.
 */
const POLICIES_EXPECTED_ABSENT = [
  ['gmail_connections', 'demo_anon_select_gmail_connections', 'anon read of an OAuth token table (383 re-added what 064 excluded)'],
  ['venue_config', 'anon_insert_venue_config', 'anon write of a row holding gmail/calendly/omi tokens'],
  ['venue_config', 'anon_update_venue_config', 'anon write of a row holding gmail/calendly/omi tokens'],
  ['venue_config', 'anon_delete_venue_config', 'anon delete of a row holding gmail/calendly/omi tokens'],
  ['venue_config', 'anon_select_venue_config', '027 wide-open read'],
  ['venue_config', 'venue_isolation', '006 FOR ALL policy: OR-ed past the role gate on writes'],
  ['venue_config', 'venue_scope_update', 'the 056-062 rename of 006: own venue, no role gate'],
  ['venue_config', 'venue_scope_insert', 'no role gate'],
  ['venue_config', 'venue_scope_delete', 'delete-then-insert route to feature_flags'],
  ['venue_config', 'super_admin_all', 'folded into the new policies'],
  ['team_invitations', 'anon_select_invitations', 'every pending invite token readable with the public anon key'],
  ['team_invitations', 'auth_all_invitations', 'any signed-in user could read or alter any org’s invitations'],
  ['team_invitations', 'demo_anon_select_team_invitations', 'anon read of invite tokens; 064 excluded this table on purpose'],
  ['team_invitations', 'team_invitations_modify', 'FOR ALL, no role gate: invite yourself as org_admin'],
  ['team_invitations', 'team_invitations_org_insert', 'no role gate'],
  ['team_invitations', 'team_invitations_org_update', 'no role gate'],
  ['team_invitations', 'team_invitations_org_delete', 'no role gate'],
  ['knot_template_patterns', 'demo_anon_select_patterns', 'FOR SELECT TO anon USING (true)'],
]

/**
 * Table policies 411 creates.
 */
// [table, policy, why, mustBeRoleGated]. The last flag matters: 058
// already ships a `venue_config_org_update`, so the name alone proves
// nothing. What 411 changes is the predicate.
const POLICIES_EXPECTED_PRESENT = [
  ['venue_config', 'venue_config_read', 'venue-scoped read, replaces the 006 FOR ALL', false],
  ['venue_config', 'venue_config_org_update', 'write gated on org_admin / venue_manager / super_admin', true],
  ['venue_config', 'venue_config_org_delete', 'closes the delete-then-insert route to feature_flags', true],
  ['team_invitations', 'team_invitations_org_select', 'own org only', false],
  ['team_invitations', 'team_invitations_admin_write', 'org_admin / venue_manager only', true],
  ['twilio_number_claims', 'twilio_number_claims_select', 'the new uniqueness table', false],
]

/**
 * Tables 411 touches that may simply not be there. As of 2026-09-14
 * production is missing all five: 310 sits in the legacy list, 401 / 407
 * are pending, 283 was never applied. Their lines below read OK because
 * nothing is granted on a table that does not exist, which is true but
 * not reassuring, so they are named here instead of read as done.
 */
const MAY_BE_ABSENT = [
  'google_ads_connections', 'meta_ads_connections', 'tiktok_ads_connections',
  'instagram_connections', 'knot_template_patterns',
]

/**
 * Columns that must not be SELECTable by `authenticated` (or `anon`).
 */
const COLUMNS_EXPECTED_UNGRANTED = [
  ['google_ads_connections', 'access_token'],
  ['google_ads_connections', 'refresh_token'],
  ['zoom_connections', 'access_token'],
  ['zoom_connections', 'refresh_token'],
  ['openphone_connections', 'api_key'],
  ['venue_config', 'gmail_tokens'],
  ['venue_config', 'calendly_tokens'],
  ['venue_config', 'omi_webhook_token'],
]

/**
 * Columns that `authenticated` must not be able to INSERT or UPDATE:
 * the env-var-name indirection and the Instagram routing key.
 */
const COLUMNS_EXPECTED_UNWRITABLE = [
  ['meta_ads_connections', 'token_env_key'],
  ['meta_ads_connections', 'access_token'],
  ['meta_ads_connections', 'status'],
  ['tiktok_ads_connections', 'token_env_key'],
  ['tiktok_ads_connections', 'access_token'],
  ['tiktok_ads_connections', 'refresh_token'],
  ['tiktok_ads_connections', 'status'],
  ['instagram_connections', 'page_token_env_key'],
  ['instagram_connections', 'page_access_token'],
  ['instagram_connections', 'ig_business_id'],
  ['instagram_connections', 'status'],
]

/** Other schema markers 411 leaves behind. */
const SCHEMA_MARKERS = [
  ['team_invitations', 'token_hash', 'hashed invite token (S1 writes it)'],
  ['booked_vendors', 'portal_token_hash', 'hashed vendor portal token'],
]

const CONSTRAINTS_EXPECTED = [
  ['meta_ads_connections_token_env_key_shape', 'env-var name shape'],
  ['tiktok_ads_connections_token_env_key_shape', 'env-var name shape'],
  ['instagram_connections_page_token_env_key_shape', 'env-var name shape'],
]

// ---------------------------------------------------------------------------
// SQL literals (all read-only)
// ---------------------------------------------------------------------------

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const arrLit = (a) => `ARRAY[${a.map(lit).join(',')}]`

const Q = {
  storagePolicies: `SELECT coalesce(string_agg(
       policyname || chr(9) || array_to_string(roles, '+') || chr(9) || cmd || chr(9)
       || CASE WHEN (coalesce(qual,'') || coalesce(with_check,'')) LIKE '%foldername%'
               THEN 'scoped' ELSE 'bucket-only' END
       || chr(9) || coalesce(substring((coalesce(qual,'') || ' ' || coalesce(with_check,''))
            from '(couple-photos|inspo-gallery|vendor-contracts|contracts|venue-assets|brain-dump|crm-imports|day-of-media)'), '?'),
       chr(10) ORDER BY policyname), '') INTO r
     FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (coalesce(qual,'') || ' ' || coalesce(with_check,''))
          ~ '(couple-photos|inspo-gallery|vendor-contracts|contracts|venue-assets|brain-dump|crm-imports|day-of-media)';`,

  tablePolicies: (tables) => `SELECT coalesce(string_agg(
       tablename || chr(9) || policyname || chr(9) || array_to_string(roles, '+') || chr(9) || cmd
       || chr(9) || CASE WHEN (coalesce(qual,'') || coalesce(with_check,'')) LIKE '%org_admin%'
                         THEN 'rolegated' ELSE 'open' END,
       chr(10) ORDER BY tablename, policyname), '') INTO r
     FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(${arrLit(tables)});`,

  tablesPresent: (tables) => `SELECT coalesce(string_agg(table_name, chr(10) ORDER BY table_name), '') INTO r
     FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${arrLit(tables)});`,

  columnGrants: `SELECT coalesce(string_agg(
       table_name || chr(9) || column_name || chr(9) || grantee || chr(9) || privilege_type,
       chr(10) ORDER BY table_name, column_name, grantee, privilege_type), '') INTO r
     FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('anon','authenticated')
      AND privilege_type IN ('SELECT','INSERT','UPDATE')
      -- Only the columns 411 is about. The full grant table for these
      -- seven tables runs to hundreds of rows and the probe carries its
      -- answer in an error message, which is not the place for that.
      AND column_name IN ('access_token','refresh_token','api_key',
                          'page_access_token','token_env_key','page_token_env_key',
                          'gmail_tokens','calendly_tokens','omi_webhook_token',
                          'status','ig_business_id')
      AND table_name IN ('google_ads_connections','zoom_connections','openphone_connections',
                         'venue_config','meta_ads_connections','tiktok_ads_connections',
                         'instagram_connections');`,

  columns: `SELECT coalesce(string_agg(table_name || '.' || column_name, chr(10) ORDER BY 1), '') INTO r
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'team_invitations' AND column_name = 'token_hash')
        OR (table_name = 'booked_vendors' AND column_name = 'portal_token_hash'));`,

  constraints: `SELECT coalesce(string_agg(conname || chr(9) || CASE WHEN convalidated THEN 'validated' ELSE 'NOT VALID' END, chr(10) ORDER BY conname), '') INTO r
     FROM pg_constraint
    WHERE conname LIKE '%\\_env\\_key\\_shape';`,

  twilioTable: `SELECT CASE WHEN to_regclass('public.twilio_number_claims') IS NULL THEN 'absent' ELSE 'present' END INTO r;`,
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = []
let needs = 0
let ok = 0
let unknown = 0
let absent = 0

function mark(status, label, detail) {
  if (status === 'OK') ok++
  else if (status === 'NEEDS 411') needs++
  else if (status === 'ABSENT') absent++
  else unknown++
  results.push({ status, label, detail })
}

function parseRows(text) {
  if (!text) return []
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\t'))
}

const buckets = await listBuckets()
const storagePol = await readScalar('storage.objects policies', Q.storagePolicies)
const tablePol = await readScalar(
  'public policies',
  Q.tablePolicies([
    'gmail_connections', 'venue_config', 'team_invitations',
    'knot_template_patterns', 'twilio_number_claims',
  ]),
)
const grants = await readScalar('column grants', Q.columnGrants)
const cols = await readScalar('schema markers', Q.columns)
const cons = await readScalar('env-key constraints', Q.constraints)
const twilio = await readScalar('twilio_number_claims', Q.twilioTable)
const present = await readScalar('tables present', Q.tablesPresent(MAY_BE_ABSENT))

// --- tables that may not be there yet --------------------------------------
if (present.error) {
  mark('UNKNOWN', 'tables 411 touches conditionally', `could not read: ${present.error}`)
} else {
  const live = new Set(parseRows(present.value).map((r) => r[0]))
  for (const t of MAY_BE_ABSENT) {
    mark(
      live.has(t) ? 'OK' : 'ABSENT',
      `table ${t}`,
      live.has(t) ? 'present; 411 grants and constraints apply' : 'not in this database; 411 skips it, and its grant lines below read OK for that reason',
    )
  }
}

// --- buckets ---------------------------------------------------------------
if (buckets.error) {
  mark('UNKNOWN', 'storage.buckets', `could not read: ${buckets.error}`)
} else {
  const byId = new Map(buckets.value.map((b) => [b.id, b]))
  for (const [id, wantPublic, why] of BUCKETS) {
    const b = byId.get(id)
    if (!b) {
      mark('UNKNOWN', `bucket ${id}`, 'bucket does not exist')
      continue
    }
    mark(
      b.public === wantPublic ? 'OK' : 'NEEDS 411',
      `bucket ${id}.public`,
      `live=${b.public} expected=${wantPublic} — ${why}`,
    )
  }
  const va = byId.get('venue-assets')
  if (va) {
    const mimes = va.allowed_mime_types
    const hasList = Array.isArray(mimes) && mimes.length > 0
    const hasSvg = hasList && mimes.some((m) => /svg/i.test(m))
    mark(
      hasList && !hasSvg ? 'OK' : 'NEEDS 411',
      'bucket venue-assets.allowed_mime_types',
      hasList ? `${mimes.length} types, svg ${hasSvg ? 'PRESENT' : 'excluded'}` : 'unset (anything uploadable, svg included)',
    )
  }
}

// --- storage.objects policies ---------------------------------------------
if (storagePol.error) {
  mark('UNKNOWN', 'storage.objects policies', `could not read: ${storagePol.error}`)
} else {
  const rows = parseRows(storagePol.value)
  const anonRows = rows.filter((r) => (r[1] || '').split('+').includes('anon'))
  mark(
    anonRows.length === 0 ? 'OK' : 'NEEDS 411',
    'storage.objects anon policies on the nine buckets',
    anonRows.length === 0 ? 'none' : anonRows.map((r) => r[0]).join(', '),
  )
  for (const bucket of SCOPED_BUCKETS) {
    const mine = rows.filter((r) => r[4] === bucket)
    const unscoped = mine.filter((r) => r[3] === 'bucket-only')
    if (mine.length === 0) {
      mark('UNKNOWN', `storage.objects policies for ${bucket}`, 'no policy mentions this bucket')
      continue
    }
    mark(
      unscoped.length === 0 ? 'OK' : 'NEEDS 411',
      `storage.objects folder scoping for ${bucket}`,
      unscoped.length === 0
        ? `${mine.length} policies, all carry a storage.foldername predicate`
        : `bucket-id-only: ${unscoped.map((r) => r[0]).join(', ')}`,
    )
  }
}

// --- table policies --------------------------------------------------------
if (tablePol.error) {
  mark('UNKNOWN', 'public policies', `could not read: ${tablePol.error}`)
} else {
  const rows = parseRows(tablePol.value)
  const find = (t, p) => rows.find((r) => r[0] === t && r[1] === p)
  for (const [table, policy, why] of POLICIES_EXPECTED_ABSENT) {
    mark(find(table, policy) ? 'NEEDS 411' : 'OK', `${table}.${policy} absent`, why)
  }
  for (const [table, policy, why, roleGated] of POLICIES_EXPECTED_PRESENT) {
    const row = find(table, policy)
    if (!row) {
      mark('NEEDS 411', `${table}.${policy} present`, why)
    } else if (roleGated && row[4] !== 'rolegated') {
      mark('NEEDS 411', `${table}.${policy} present`, `${why} — policy exists but its predicate has no role gate`)
    } else {
      mark('OK', `${table}.${policy} present`, why)
    }
  }
}

// --- column grants ---------------------------------------------------------
if (grants.error) {
  mark('UNKNOWN', 'column grants', `could not read: ${grants.error}`)
} else {
  const rows = parseRows(grants.value)
  const granted = (t, c, priv) =>
    rows.some((r) => r[0] === t && r[1] === c && r[3] === priv)
  for (const [table, column] of COLUMNS_EXPECTED_UNGRANTED) {
    const leaks = granted(table, column, 'SELECT')
    mark(leaks ? 'NEEDS 411' : 'OK', `${table}.${column} not SELECTable by anon/authenticated`,
      leaks ? 'grant still present' : 'no grant')
  }
  for (const [table, column] of COLUMNS_EXPECTED_UNWRITABLE) {
    const leaks = granted(table, column, 'INSERT') || granted(table, column, 'UPDATE')
    mark(leaks ? 'NEEDS 411' : 'OK', `${table}.${column} not writable by authenticated`,
      leaks ? 'INSERT/UPDATE grant still present' : 'no write grant')
  }
}

// --- schema markers --------------------------------------------------------
if (cols.error) {
  mark('UNKNOWN', 'schema markers', `could not read: ${cols.error}`)
} else {
  const present = new Set(parseRows(cols.value).map((r) => r[0]))
  for (const [table, column, why] of SCHEMA_MARKERS) {
    mark(present.has(`${table}.${column}`) ? 'OK' : 'NEEDS 411', `${table}.${column}`, why)
  }
}

if (cons.error) {
  mark('UNKNOWN', 'env-key CHECK constraints', `could not read: ${cons.error}`)
} else {
  const rows = parseRows(cons.value)
  for (const [name, why] of CONSTRAINTS_EXPECTED) {
    const row = rows.find((r) => r[0] === name)
    mark(row ? 'OK' : 'NEEDS 411', name, row ? `${row[1]} — ${why}` : why)
  }
}

if (twilio.error) {
  mark('UNKNOWN', 'twilio_number_claims', `could not read: ${twilio.error}`)
} else {
  mark(twilio.value === 'present' ? 'OK' : 'NEEDS 411', 'twilio_number_claims table',
    'one phone number, one venue')
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

if (JSON_OUT) {
  console.log(JSON.stringify({ ok, needs, absent, unknown, results }, null, 2))
  process.exit(0)
}

const width = results.reduce((n, r) => Math.max(n, r.label.length), 0)
console.log(`check-live-policies: reading ${BASE.replace(/https:\/\/([a-z0-9]+)\..*/, '$1')} (read only)\n`)
for (const r of results) {
  console.log(`  ${r.status.padEnd(10)} ${r.label.padEnd(width)}  ${r.detail}`)
}
console.log(`\n${ok} ok · ${needs} needs 411 · ${absent} table absent · ${unknown} unknown`)
if (needs > 0) {
  console.log('\nThe `NEEDS 411` lines are what migration 411 is for. Re-run after the operator applies it.')
}
process.exit(0)
