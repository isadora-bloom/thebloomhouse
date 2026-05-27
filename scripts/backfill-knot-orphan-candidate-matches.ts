/**
 * scripts/backfill-knot-orphan-candidate-matches.ts
 * =================================================
 * Surface stranded Knot orphan touchpoints in /intel/identity-review.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Diagnosis (verified 2026-05-26 against prod ref `jsxxgwprxuqgcauzlxcb`):
 *   - 5138 total touchpoints; channel='the_knot' has 625 of them.
 *   - Of the 625, 295 have `couple_id IS NULL` — orphans.
 *   - Of the 295 orphans, 294 have NO corresponding row in
 *     `candidate_matches` (with secondary_record_type='touchpoint'),
 *     so they NEVER surface in the identity-review queue.
 *   - All 294 carry `action_type='channel_engagement'` and span
 *     2025-06 → 2026-05 (the Knot importer's full operating range).
 *
 * Why they were swallowed
 * -----------------------
 * Migration 360 (`360_candidate_matches_touchpoint_type.sql`, applied
 * 2026-05-18) extended the `candidate_matches.primary_record_type` and
 * `secondary_record_type` CHECK constraints to include `'touchpoint'`.
 * Before mig 360, route-by-tier.ts:128-152 (medium/low branch) tried to
 * INSERT a candidate_match with `secondary_record_type='touchpoint'`
 * and hit a 23514 CHECK violation. `insertCandidateMatch` (tracer.ts:395)
 * swallows every non-23505 error as a logged warning. Net effect: every
 * medium/low Knot signal landed as an orphan touchpoint with NO
 * candidate_matches row — invisible to the operator review queue.
 *
 * Mig 360's migration comment documents this gap exactly. This script
 * is the historical-data cleanup for orphans that pre-date it.
 *
 * (The original task brief referenced mig 363; mig 363 is a couples
 * cleanup, unrelated. The actual CHECK extension is mig 360. Story is
 * the same — pre-mig-360 candidate_matches inserts of type 'touchpoint'
 * were swallowed.)
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * For each stranded Knot orphan touchpoint:
 *   1. Reconstruct a MatchableRecord from raw_payload (first_name +
 *      last_initial; email/phone are null for Knot signals).
 *   2. Score against the venue's recent couples using `scoreCandidate`
 *      (same matcher route-by-tier would have used live).
 *   3. Pick the top candidates that clear TIER_LOW (>= 30) — same
 *      threshold route-by-tier uses to queue a medium/low match.
 *   4. INSERT one `candidate_matches` row per (orphan-touchpoint,
 *      top-couple) pair: primary_record_type='couple',
 *      secondary_record_type='touchpoint', confidence_tier from the
 *      verdict's band. Idempotent via `uq_candidate_matches_pair`
 *      (mig 358) — re-runs no-op.
 *   5. If NO couple scores >= 30, the orphan stays an orphan but a
 *      single SENTINEL candidate_match row is written against the
 *      orphan itself (primary=touchpoint, secondary=touchpoint, same
 *      id, tier='low', reason='no-candidate-couple — needs operator
 *      review') so it surfaces in the queue. NOTE: the
 *      uq_candidate_matches_pair index makes the self-pair unique by
 *      (venue_id, id, 'touchpoint', id, 'touchpoint'), so this is
 *      idempotent too.
 *
 * NOT what this script does
 * -------------------------
 * - Does NOT mint anything. No couples, no fragments, no touchpoint
 *   re-parenting. Pure surfacing.
 * - Does NOT call the LLM judge. The matcher's structured score is
 *   sufficient to seed the queue; the operator (or a subsequent judge
 *   sweep) makes the final call.
 * - Does NOT touch the existing 6 candidate_matches rows that already
 *   reference touchpoint type (already in the queue).
 *
 * SAFETY
 * ------
 * - Dry-run by default. `--apply` writes.
 * - `--allow-prod` REQUIRED if BRANCH_URL / NEXT_PUBLIC_SUPABASE_URL
 *   points at the prod ref `jsxxgwprxuqgcauzlxcb` AND `--apply` is set.
 * - Only writes to `candidate_matches`. `candidate_matches` is NOT in
 *   the `check-cascade-only-writer.mjs` GUARDED_TABLES — it's a
 *   sidecar surface, not a spine table — so this script does not trip
 *   the cascade-only-writer CI guard. (The guard also only walks
 *   `src/`, not `scripts/`.)
 *
 * IDEMPOTENCY
 * -----------
 * - `uq_candidate_matches_pair` (mig 358) on (venue_id,
 *   primary_record_id, primary_record_type, secondary_record_id,
 *   secondary_record_type). Re-running produces no new rows.
 * - The script also pre-loads all existing
 *   `candidate_matches.secondary_record_id WHERE
 *   secondary_record_type='touchpoint'` and skips orphans already
 *   surfaced.
 *
 * USAGE
 * -----
 *   # Dry-run vs default env (.env.local):
 *   npx tsx scripts/backfill-knot-orphan-candidate-matches.ts
 *
 *   # Dry-run vs a Supabase branch (e.g. consolidation branch
 *   # ciwqxwohczzthvzqqgjx):
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key_for_branch> \
 *   npx tsx scripts/backfill-knot-orphan-candidate-matches.ts
 *
 *   # Apply vs branch:
 *   BRANCH_URL=... BRANCH_KEY=... \
 *   npx tsx scripts/backfill-knot-orphan-candidate-matches.ts --apply
 *
 *   # Apply vs prod (requires --allow-prod):
 *   npx tsx scripts/backfill-knot-orphan-candidate-matches.ts --apply --allow-prod
 *
 *   # Scope to a single venue (default: every venue):
 *   BACKFILL_VENUE_ID=<uuid> npx tsx scripts/backfill-knot-orphan-candidate-matches.ts
 *
 *   # Cap how many couples to surface per orphan (default 3):
 *   BACKFILL_TOP_N=5 npx tsx scripts/backfill-knot-orphan-candidate-matches.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import {
  scoreCandidate,
  type MatchableRecord,
  type MatcherVerdict,
} from '../src/lib/services/identity/matcher'
import {
  loadRecentCouples,
  coupleToMatchableRecord,
  insertCandidateMatch,
  type CoupleForMatch,
} from '../src/lib/services/identity/tracer'

// ---------------------------------------------------------------------------
// Env loader — mirrors backfill-couples-bridge.ts and the other
// .env.local-aware scripts. Branch creds (BRANCH_URL / BRANCH_KEY)
// override the default Supabase URL/key when set.
// ---------------------------------------------------------------------------

if (existsSync('.env.local')) {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [
          l.slice(0, i).trim(),
          l.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''),
        ]
      }),
  )
  for (const k of Object.keys(env)) {
    if (!process.env[k]) process.env[k] = env[k] as string
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

const VENUE_SCOPE = process.env.BACKFILL_VENUE_ID || null
const TOP_N = Math.max(
  1,
  Number(process.env.BACKFILL_TOP_N) || 3,
)

/** Knot/WeddingWire/Zola channel aliases — same set the Knot source
 *  adapter (sources/knot.ts) uses for `source_platform`. Touchpoints
 *  written by the live pipeline carry the platform string itself, so
 *  on prod today this matches `the_knot` only. */
const KNOT_CHANNELS = ['the_knot', 'knot', 'wedding_wire', 'weddingwire', 'zola']

const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const PAGE = 1000

// Matcher tier threshold the script will queue. Mirrors route-by-tier's
// medium/low branch: anything scoring >= TIER_LOW (30) goes into the
// queue. Below that, the orphan still gets a SENTINEL candidate_match
// so the operator sees it, but with no proposed couple attached.
const TIER_LOW = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrphanTouchpoint {
  id: string
  venue_id: string
  channel: string
  action_type: string
  external_id: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Paginated fetch helper
// ---------------------------------------------------------------------------

async function fetchAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

// ---------------------------------------------------------------------------
// Knot orphan → MatchableRecord
// ---------------------------------------------------------------------------

/** Reconstruct a MatchableRecord from a Knot orphan touchpoint's
 *  raw_payload. Knot signals carry first_name + last_initial (NOT a
 *  full last_name on the orphan rows we have today — last_name is
 *  always null in the observed sample). Email/phone are null on the
 *  candidate_identities clusters the orphan touchpoints came from,
 *  so name + occurred_at are the only signals available.
 *
 *  We assemble `primary_name` as "first last_initial." so the matcher's
 *  `firstPlusInitialMatches` (W.first_name_plus_last_initial = 25) can
 *  fire. The Glascow/Minette bonus and full_name_exact won't fire — we
 *  don't have a full last name. Best we can do today. */
function knotOrphanToMatchable(tp: OrphanTouchpoint): MatchableRecord {
  const payload = (tp.raw_payload ?? {}) as Record<string, unknown>
  const firstName = typeof payload.first_name === 'string' ? payload.first_name : null
  const lastInitial = typeof payload.last_initial === 'string' ? payload.last_initial : null
  const lastName = typeof payload.last_name === 'string' ? payload.last_name : null
  const email = typeof payload.email === 'string' ? payload.email : null
  const phone = typeof payload.phone === 'string' ? payload.phone : null

  // Prefer full last name if present (rare on Knot); fall back to
  // initial. If both absent, return just the first name — the matcher
  // refuses to fire fullName/initial signals without two tokens, so
  // those orphans will only ever surface as SENTINELs below.
  const primary_name =
    firstName && lastName
      ? `${firstName} ${lastName}`
      : firstName && lastInitial
        ? `${firstName} ${lastInitial}`
        : firstName

  return {
    id: tp.id,
    primary_name,
    partner_name: null,
    primary_email: email,
    partner_email: null,
    primary_phone: phone,
    partner_phone: null,
    wedding_date: null,
    observed_at: tp.occurred_at,
    session_ip: null,
    session_fingerprint: null,
  }
}

// ---------------------------------------------------------------------------
// Per-venue scoring + write
// ---------------------------------------------------------------------------

interface VenueResult {
  venue_id: string
  orphans_seen: number
  already_surfaced: number
  scored: number
  candidates_queued: number
  sentinel_queued: number
  failed: number
  /** sample for dry-run logging. */
  samples: Array<{
    orphan_id: string
    name: string | null
    occurred_at: string
    proposals: Array<{
      couple_id: string
      tier: string
      score: number
      reason: string
    }>
  }>
}

async function processVenue(
  supabase: SupabaseClient,
  venueId: string,
  orphans: OrphanTouchpoint[],
  alreadySurfaced: Set<string>,
): Promise<VenueResult> {
  const result: VenueResult = {
    venue_id: venueId,
    orphans_seen: orphans.length,
    already_surfaced: 0,
    scored: 0,
    candidates_queued: 0,
    sentinel_queued: 0,
    failed: 0,
    samples: [],
  }

  const toProcess = orphans.filter((o) => !alreadySurfaced.has(o.id))
  result.already_surfaced = orphans.length - toProcess.length
  if (toProcess.length === 0) return result

  const couples: CoupleForMatch[] = await loadRecentCouples(supabase, venueId)
  if (couples.length === 0) {
    // No couples to score against — every orphan becomes a sentinel.
    for (const o of toProcess) {
      if (APPLY) {
        try {
          await insertCandidateMatch(
            supabase,
            venueId,
            o.id, 'touchpoint',
            o.id, 'touchpoint',
            'low',
            'no candidate couples in venue — orphan needs operator review',
          )
          result.sentinel_queued++
        } catch (err) {
          result.failed++
        }
      } else {
        result.sentinel_queued++
      }
    }
    return result
  }

  const coupleRecords = couples.map((c) => ({
    couple: c,
    record: coupleToMatchableRecord(c),
  }))

  const SAMPLE_LIMIT = 5

  for (const orphan of toProcess) {
    const orphanRecord = knotOrphanToMatchable(orphan)
    result.scored++

    // Score against every couple. Keep verdicts that clear TIER_LOW,
    // sort by score desc, take top N. Self-id collisions are
    // impossible (couple ids != touchpoint ids), so scoreCandidate's
    // self-match guard is irrelevant here.
    const verdicts: Array<{ couple: CoupleForMatch; verdict: MatcherVerdict }> = []
    for (const cr of coupleRecords) {
      const v = scoreCandidate(orphanRecord, cr.record)
      if (v.score >= TIER_LOW) verdicts.push({ couple: cr.couple, verdict: v })
    }
    verdicts.sort((a, b) => b.verdict.score - a.verdict.score)
    const top = verdicts.slice(0, TOP_N)

    if (top.length === 0) {
      // SENTINEL: no couple scored ≥ 30. The orphan would otherwise
      // stay invisible. Self-pair so uq_candidate_matches_pair makes
      // it idempotent.
      if (APPLY) {
        try {
          await insertCandidateMatch(
            supabase,
            venueId,
            orphan.id, 'touchpoint',
            orphan.id, 'touchpoint',
            'low',
            `knot-orphan-backfill: no candidate couple ≥ TIER_LOW (${TIER_LOW}) — operator review`,
          )
          result.sentinel_queued++
        } catch (err) {
          result.failed++
        }
      } else {
        result.sentinel_queued++
      }
      if (result.samples.length < SAMPLE_LIMIT) {
        result.samples.push({
          orphan_id: orphan.id,
          name: orphanRecord.primary_name ?? null,
          occurred_at: orphan.occurred_at,
          proposals: [],
        })
      }
      continue
    }

    const sample: VenueResult['samples'][number] = {
      orphan_id: orphan.id,
      name: orphanRecord.primary_name ?? null,
      occurred_at: orphan.occurred_at,
      proposals: [],
    }
    for (const t of top) {
      // candidate_matches.confidence_tier is one of 'high'|'medium'|'low'.
      // The matcher's MatchTier additionally has 'below_threshold' but
      // we already filtered to >= TIER_LOW above so that case is
      // unreachable here.
      const tier: 'high' | 'medium' | 'low' =
        t.verdict.tier === 'below_threshold' ? 'low' : t.verdict.tier
      if (APPLY) {
        try {
          await insertCandidateMatch(
            supabase,
            venueId,
            t.couple.id, 'couple',
            orphan.id, 'touchpoint',
            tier,
            `knot-orphan-backfill: ${t.verdict.reason}`,
          )
          result.candidates_queued++
        } catch (err) {
          result.failed++
        }
      } else {
        result.candidates_queued++
      }
      sample.proposals.push({
        couple_id: t.couple.id,
        tier,
        score: t.verdict.score,
        reason: t.verdict.reason,
      })
    }
    if (result.samples.length < SAMPLE_LIMIT) result.samples.push(sample)
  }

  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.BRANCH_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.BRANCH_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      'ERROR: Supabase URL/key not found.\n' +
        'Either set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ' +
        '(or BRANCH_URL + BRANCH_KEY) in the environment or in .env.local.',
    )
    process.exit(1)
  }
  if (url.includes(PROD_REF) && APPLY && !ALLOW_PROD) {
    console.error(
      `ERROR: target URL is prod (${PROD_REF}) and --apply is set.\n` +
        'Pass --allow-prod to override (writes are idempotent via ' +
        'uq_candidate_matches_pair, but operator opt-in is required).',
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const tag = APPLY ? '[APPLY]' : '[DRY-RUN]'
  console.log('='.repeat(78))
  console.log(`${tag} backfill-knot-orphan-candidate-matches`)
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue scope  : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log(`Top-N        : ${TOP_N}`)
  console.log(`Channels     : ${KNOT_CHANNELS.join(', ')}`)
  console.log('')

  // -------------------------------------------------------------------------
  // 1. Pull all Knot orphan touchpoints (couple_id IS NULL).
  // -------------------------------------------------------------------------
  console.log('[1] Loading Knot orphan touchpoints…')
  const orphans = await fetchAll<OrphanTouchpoint>('touchpoints', (from, to) => {
    let q = supabase
      .from('touchpoints')
      .select('id, venue_id, channel, action_type, external_id, occurred_at, raw_payload')
      .in('channel', KNOT_CHANNELS)
      .is('couple_id', null)
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (VENUE_SCOPE) q = q.eq('venue_id', VENUE_SCOPE)
    return q
  })
  console.log(`    orphan touchpoints found: ${orphans.length}`)

  if (orphans.length === 0) {
    console.log('Nothing to surface. Exiting.')
    return
  }

  // -------------------------------------------------------------------------
  // 2. Pre-load existing candidate_matches with secondary='touchpoint'
  //    so we skip orphans that are already in the queue.
  // -------------------------------------------------------------------------
  console.log('[2] Loading existing candidate_matches (touchpoint type)…')
  const cmRows = await fetchAll<{
    secondary_record_id: string
    primary_record_id: string
    primary_record_type: string
    secondary_record_type: string
  }>('candidate_matches', (from, to) =>
    supabase
      .from('candidate_matches')
      .select('secondary_record_id, secondary_record_type, primary_record_id, primary_record_type')
      .or('secondary_record_type.eq.touchpoint,primary_record_type.eq.touchpoint')
      .range(from, to),
  )
  const alreadySurfaced = new Set<string>()
  for (const r of cmRows) {
    if (r.secondary_record_type === 'touchpoint') alreadySurfaced.add(r.secondary_record_id)
    if (r.primary_record_type === 'touchpoint') alreadySurfaced.add(r.primary_record_id)
  }
  console.log(`    candidate_matches w/ touchpoint type: ${alreadySurfaced.size}`)

  // -------------------------------------------------------------------------
  // 3. Group orphans by venue, then process per venue.
  // -------------------------------------------------------------------------
  const byVenue = new Map<string, OrphanTouchpoint[]>()
  for (const o of orphans) {
    const arr = byVenue.get(o.venue_id) ?? []
    arr.push(o)
    byVenue.set(o.venue_id, arr)
  }
  console.log(`    venues with Knot orphans: ${byVenue.size}`)
  console.log('')

  const allResults: VenueResult[] = []
  for (const [venueId, vOrphans] of byVenue) {
    console.log(`[venue ${venueId}] orphans=${vOrphans.length}`)
    const r = await processVenue(supabase, venueId, vOrphans, alreadySurfaced)
    allResults.push(r)
    console.log(
      `    seen=${r.orphans_seen}  already_surfaced=${r.already_surfaced}  ` +
        `scored=${r.scored}  proposals_queued=${r.candidates_queued}  ` +
        `sentinels=${r.sentinel_queued}  failed=${r.failed}`,
    )
    if (r.samples.length > 0) {
      console.log('    SAMPLE:')
      for (const s of r.samples) {
        console.log(
          `      orphan=${s.orphan_id}  name="${s.name ?? '(null)'}"  at=${s.occurred_at}`,
        )
        if (s.proposals.length === 0) {
          console.log('        → no couple candidates (SENTINEL queued)')
        } else {
          for (const p of s.proposals) {
            console.log(
              `        → couple=${p.couple_id}  tier=${p.tier}  score=${p.score}  reason="${p.reason}"`,
            )
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Aggregate report.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('='.repeat(78))
  console.log('RESULT')
  console.log('='.repeat(78))
  const agg = allResults.reduce(
    (acc, r) => {
      acc.orphans_seen += r.orphans_seen
      acc.already_surfaced += r.already_surfaced
      acc.scored += r.scored
      acc.candidates_queued += r.candidates_queued
      acc.sentinel_queued += r.sentinel_queued
      acc.failed += r.failed
      return acc
    },
    { orphans_seen: 0, already_surfaced: 0, scored: 0, candidates_queued: 0, sentinel_queued: 0, failed: 0 },
  )
  console.log(`  total orphans seen          : ${agg.orphans_seen}`)
  console.log(`  already in review queue     : ${agg.already_surfaced}`)
  console.log(`  scored                      : ${agg.scored}`)
  console.log(`  candidate_matches queued    : ${agg.candidates_queued}`)
  console.log(`  sentinel candidate_matches  : ${agg.sentinel_queued}`)
  console.log(`  failed                      : ${agg.failed}`)
  console.log('')
  if (!APPLY) {
    console.log('DRY-RUN — no writes. Re-run with --apply to insert the rows.')
  } else {
    console.log('All writes complete. Re-run is a no-op (uq_candidate_matches_pair).')
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
