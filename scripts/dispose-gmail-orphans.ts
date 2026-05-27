/**
 * scripts/dispose-gmail-orphans.ts
 * ================================
 *
 * Orphan-touchpoint diagnosis fix companion #4 (2026-05-27).
 *
 * THE GAP THIS COVERS
 * -------------------
 * `reattach-couple-author-orphans.ts` (2026-05-26) handles the SUBSET of
 * `touchpoints` rows with `channel='gmail'`, `couple_id IS NULL` whose
 * source interaction was classified `author_class='couple'`. That sweep
 * binds those rows back to a real couple via the cascade matcher.
 *
 * This script handles the COMPLEMENT — every other author_class bucket
 * for the same orphan set:
 *
 *   - vendor                — venue's existing vendors (florists, DJs,
 *                             rentals, etc.) that should NEVER mint or
 *                             attach to a couple.
 *   - platform_system       — Calendly / HoneyBook / Gmail system
 *                             notification emails. Same.
 *   - sage                  — Sage's own outbound emails round-tripped
 *                             back into the venue inbox.
 *   - operator              — venue staff replies. Belong on the
 *                             corresponding couple thread (handled
 *                             elsewhere) but NOT as standalone signals.
 *   - couple (unmatchable)  — author_class said 'couple' but cascade
 *                             already failed to find any match. These
 *                             are real-couple signals that the
 *                             reattach sweep also could not bind.
 *                             Doctrinally these should become Fragment
 *                             rows for backtracer to pick up later.
 *   - unknown               — classifier never ran or returned 'unknown'.
 *                             Leave alone — no decision is the right
 *                             decision until the classifier runs.
 *
 * The doctrine question this script ASKS but does NOT answer with
 * writes:
 *
 *   For each non-couple bucket, what is the right end-state of the
 *   touchpoint row? A `vendor` orphan is noise — it never belonged in
 *   the spine, and the live cascade now short-circuits on
 *   author_class!='couple' (mint-couple.ts:103-106). The historical row
 *   exists because the pre-classifier pipeline let it land. The
 *   doctrinally-correct disposition is "suppress" (mark it as a known
 *   non-spine signal so the operator UIs filter it out) — but doing
 *   that requires a SCHEMA FIELD on `touchpoints` to hold the
 *   disposition (e.g. `touchpoints.disposition` enum or
 *   `touchpoints.suppressed_at` timestamp).
 *
 * SCHEMA SURVEY (2026-05-27)
 * --------------------------
 * Reviewed migrations 346 (the touchpoints CREATE) through 374. The
 * `touchpoints` table has these columns and ONLY these:
 *
 *   id, venue_id, couple_id, agent_id, channel, signal_tier,
 *   action_type, external_id, occurred_at, confidence_tier, raw_payload
 *
 * There is NO `suppressed` / `suppressed_at` / `hidden` / `is_fragment`
 * / `disposition` column. Fragments live in a SEPARATE `fragments`
 * table (mig 346 line 238). A historical orphan touchpoint cannot be
 * "promoted to fragment" without also creating a row in `fragments`
 * with the correct identity_hint and then setting
 * `fragments.promoted_to_couple_id` — and that is well outside the
 * scope of a disposition sweep (it would be a fragment-creation sweep
 * and would touch the cascade-only-writer guard surface).
 *
 * Therefore this script is LOG-ONLY. It classifies every orphan, prints
 * the bucket counts + sample rows, and recommends the schema additions
 * + per-bucket actions the operator should take next. It writes
 * NOTHING under either dry-run or --apply. The --apply flag is still
 * accepted (and warns) for future use once a disposition column lands.
 *
 * SAFETY
 * ------
 *   - Refuse-by-default for prod (jsxxgwprxuqgcauzlxcb) when --apply is
 *     passed without --allow-prod, mirroring
 *     reattach-couple-author-orphans.ts §Config. (Dry-runs against
 *     prod are always allowed — read-only inspection.)
 *   - Currently --apply is a no-op (logs a banner + recommendation,
 *     performs zero writes). When a disposition schema field lands
 *     this block is where the writes belong.
 *   - Idempotent: re-running is identical to first-running because
 *     nothing changes.
 *
 * WRITER-DOCTRINE CHECK
 * ---------------------
 * Zero writes today. When writes are added (post-schema-field), they
 * will be UPDATEs (`touchpoints.suppressed_at = now()`) — UPDATEs do
 * not trip the cascade-only-writer guard (per
 * scripts/check-cascade-only-writer.mjs:5 "UPDATEs are NOT blocked").
 * Even so, the script lives in `scripts/` (outside the guard's `src/`
 * scan surface) for the same operator-sweep reason as its sibling
 * scripts (reattach-couple-author-orphans.ts, etc.).
 *
 * USAGE
 * -----
 *   # Dry-run against the persistent branch (recommended first pass):
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key_for_branch> \
 *   npx tsx scripts/dispose-gmail-orphans.ts
 *
 *   # Dry-run against prod (read-only inspection of bucket counts):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=<prod_service_role_key> \
 *   npx tsx scripts/dispose-gmail-orphans.ts
 *
 *   # Apply against prod (currently still a no-op — kept for
 *   # parity with sibling scripts):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=<prod_service_role_key> \
 *   npx tsx scripts/dispose-gmail-orphans.ts --apply --allow-prod
 *
 *   # Scope to a specific venue (default: all venues):
 *   DISPOSE_VENUE_ID=<uuid> npx tsx scripts/dispose-gmail-orphans.ts
 *
 * VERIFIED SCHEMA FACTS (2026-05-27 prod)
 * ---------------------------------------
 * - `touchpoints` columns: see SCHEMA SURVEY above.
 * - `interactions.author_class` CHECK: 'couple', 'operator', 'sage',
 *   'platform_system', 'vendor', 'unknown' (mig 293).
 * - Live cascade gate `hasSufficientIdentity` (mint-couple.ts:103-106)
 *   short-circuits gmail signals on `author_class === 'couple'` — so
 *   every other author_class going forward becomes a non-spine row by
 *   construction.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

/** Optional venue scope. Default: all venues. */
const VENUE_SCOPE = process.env.DISPOSE_VENUE_ID || null

/** Known production project ref. The sweep refuses to WRITE against
 *  this url unless --allow-prod is passed. Mirrors
 *  reattach-couple-author-orphans.ts §Config. Dry-runs against prod
 *  are always allowed (read-only). */
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TouchpointRow {
  id: string
  venue_id: string
  channel: string
  signal_tier: string
  action_type: string
  external_id: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

interface InteractionRow {
  id: string
  venue_id: string
  author_class: string
  from_email: string | null
  from_name: string | null
  subject: string | null
}

type Bucket =
  | 'vendor'
  | 'platform_system'
  | 'sage'
  | 'operator'
  | 'couple_unmatchable'
  | 'unknown'
  | 'no_interaction' // touchpoint references an interaction_id that doesn't exist (or no interaction_id at all)

interface OrphanCase {
  tp: TouchpointRow
  ix: InteractionRow | null
  bucket: Bucket
}

// ---------------------------------------------------------------------------
// Env resolution — mirror reattach-couple-author-orphans.ts §main but
// also fall through to NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// per the task spec.
// ---------------------------------------------------------------------------

function resolveEnv(): { url: string; key: string } {
  const url = process.env.BRANCH_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.BRANCH_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL/BRANCH_KEY (preferred) or NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/dispose-gmail-orphans.ts [--apply] [--allow-prod]',
    )
    process.exit(1)
  }
  return { url, key }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadOrphanTouchpoints(
  sb: SupabaseClient,
  venueScope: string | null,
): Promise<TouchpointRow[]> {
  const PAGE = 1000
  const out: TouchpointRow[] = []
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from('touchpoints')
      .select('id, venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload')
      .is('couple_id', null)
      .eq('channel', 'gmail')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (venueScope) q = q.eq('venue_id', venueScope)
    const { data, error } = await q
    if (error) throw new Error(`touchpoints: ${error.message}`)
    out.push(...((data ?? []) as TouchpointRow[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function loadInteractions(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, InteractionRow>> {
  const out = new Map<string, InteractionRow>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await sb
      .from('interactions')
      .select('id, venue_id, author_class, from_email, from_name, subject')
      .in('id', chunk)
    if (error) throw new Error(`interactions: ${error.message}`)
    for (const r of (data ?? []) as InteractionRow[]) out.set(r.id, r)
  }
  return out
}

// ---------------------------------------------------------------------------
// Bucketing — pure function.
// ---------------------------------------------------------------------------

function bucketOf(tp: TouchpointRow, ix: InteractionRow | null): Bucket {
  if (!ix) return 'no_interaction'
  switch (ix.author_class) {
    case 'vendor':
      return 'vendor'
    case 'platform_system':
      return 'platform_system'
    case 'sage':
      return 'sage'
    case 'operator':
      return 'operator'
    case 'couple':
      // The reattach-couple-author-orphans.ts sweep has had its shot at
      // these. Anything still couple_id IS NULL after that sweep ran is
      // "couple-but-unmatchable" — a real couple signal that the
      // cascade matcher could not bind. Doctrinally these want to
      // become Fragment rows (see header) — currently log-only.
      return 'couple_unmatchable'
    case 'unknown':
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { url, key } = resolveEnv()
  if (APPLY && url.includes(PROD_REF) && !ALLOW_PROD) {
    console.error(
      `ERROR: target URL points at production (${PROD_REF}) and --apply was set.\n` +
        'Pass --allow-prod to override. Dry-runs against prod are allowed without that flag.',
    )
    process.exit(1)
  }

  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })

  const isProd = url.includes(PROD_REF)
  const mode = APPLY ? (isProd ? '[APPLY · PROD]' : '[APPLY]') : '[DRY-RUN]'
  console.log('='.repeat(78))
  console.log(`${mode} dispose-gmail-orphans`)
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue scope  : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log('')
  console.log('NOTE: touchpoints has no suppression/fragment/hidden column today.')
  console.log('      This script is LOG-ONLY — --apply is currently a no-op.')
  console.log('      See header §SCHEMA SURVEY for the field that needs to land first.')
  console.log('')

  // 1. Load all orphan gmail touchpoints.
  console.log('[1] Loading orphan gmail touchpoints (couple_id IS NULL)…')
  const allOrphans = await loadOrphanTouchpoints(sb, VENUE_SCOPE)
  console.log(`    total orphan gmail touchpoints: ${allOrphans.length}`)

  if (allOrphans.length === 0) {
    console.log('\nNothing to do. Exiting.')
    return
  }

  // 2. Pull every referenced interaction so we can read author_class.
  const iids = Array.from(
    new Set(
      allOrphans
        .map((t) => (t.raw_payload?.['interaction_id'] as string | undefined) ?? null)
        .filter((v): v is string => Boolean(v)),
    ),
  )
  console.log(`    interaction ids referenced     : ${iids.length}`)

  const ixMap = iids.length > 0 ? await loadInteractions(sb, iids) : new Map<string, InteractionRow>()
  console.log(`    interactions loaded            : ${ixMap.size}`)
  console.log('')

  // 3. Bucket each orphan.
  console.log('[2] Bucketing by interaction.author_class…')
  const cases: OrphanCase[] = []
  for (const tp of allOrphans) {
    const iid = (tp.raw_payload?.['interaction_id'] as string | undefined) ?? null
    const ix = iid ? ixMap.get(iid) ?? null : null
    cases.push({ tp, ix, bucket: bucketOf(tp, ix) })
  }

  const counts: Record<Bucket, number> = {
    vendor: 0,
    platform_system: 0,
    sage: 0,
    operator: 0,
    couple_unmatchable: 0,
    unknown: 0,
    no_interaction: 0,
  }
  for (const c of cases) counts[c.bucket] += 1

  console.log('')
  console.log('-'.repeat(78))
  console.log('BUCKET BREAKDOWN')
  console.log('-'.repeat(78))
  console.log(`  vendor                 : ${counts.vendor}   (recommend: suppress)`)
  console.log(`  platform_system        : ${counts.platform_system}   (recommend: suppress)`)
  console.log(`  sage                   : ${counts.sage}   (recommend: suppress — Sage's own outbound)`)
  console.log(`  operator               : ${counts.operator}   (recommend: suppress — staff reply, lives on couple thread elsewhere)`)
  console.log(`  couple (unmatchable)   : ${counts.couple_unmatchable}   (recommend: promote to Fragment for backtracer)`)
  console.log(`  unknown                : ${counts.unknown}   (recommend: leave alone — classifier hasn't decided)`)
  console.log(`  no interaction joined  : ${counts.no_interaction}   (recommend: investigate — orphan of an orphan)`)
  console.log('')

  // 4. Sample rows per bucket (first 5 of each non-zero bucket).
  console.log('-'.repeat(78))
  console.log('SAMPLE ROWS (first 5 per non-zero bucket)')
  console.log('-'.repeat(78))
  for (const b of [
    'vendor',
    'platform_system',
    'sage',
    'operator',
    'couple_unmatchable',
    'unknown',
    'no_interaction',
  ] as Bucket[]) {
    const samples = cases.filter((c) => c.bucket === b).slice(0, 5)
    if (samples.length === 0) continue
    console.log(`\n[${b}]`)
    for (const c of samples) {
      const from = (c.ix?.from_email ?? '-').slice(0, 42).padEnd(42)
      const name = (c.ix?.from_name ?? '').slice(0, 22).padEnd(22)
      const subj = (c.ix?.subject ?? '').slice(0, 36)
      console.log(`  tp=${c.tp.id.slice(0, 8)}…  ix=${(c.ix?.id ?? '-').slice(0, 8)}…  from=${from}  name="${name}"  subj="${subj}"`)
    }
  }
  console.log('')

  // 5. Recommendation block — what to build next.
  console.log('-'.repeat(78))
  console.log('RECOMMENDATION')
  console.log('-'.repeat(78))
  console.log('  To act on these buckets, land ONE of:')
  console.log('')
  console.log('    OPTION A — `touchpoints.suppressed_at timestamptz NULL` column +')
  console.log('               `touchpoints.suppression_reason text NULL` column.')
  console.log('               Then this script SETs suppressed_at = now() for')
  console.log('               vendor / platform_system / sage / operator buckets.')
  console.log('               Operator UIs filter on suppressed_at IS NULL.')
  console.log('')
  console.log('    OPTION B — promote couple_unmatchable rows into the existing')
  console.log('               `fragments` table (mig 346) so the backtracer can')
  console.log('               coalesce them. Requires identity_hint derivation')
  console.log('               from interactions.from_email / from_name and a')
  console.log('               separate sweep — out of scope for this script.')
  console.log('')
  console.log('  Both options preserve the touchpoint row (doctrine: never DELETE)')
  console.log('  but remove it from the active "looks like an unbound couple" set.')
  console.log('')

  if (APPLY) {
    console.log('-'.repeat(78))
    console.log('APPLY MODE — no writes performed.')
    console.log('Reason: touchpoints schema has no suppression / fragment / hidden')
    console.log('        column. See header §SCHEMA SURVEY. Add the column first.')
    console.log('-'.repeat(78))
  } else {
    console.log('-'.repeat(78))
    console.log('DRY-RUN — no writes performed. --apply is currently a no-op too;')
    console.log('it remains accepted for future-compat once a disposition column lands.')
    console.log('-'.repeat(78))
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
