// Phase B historical backfill (PB.7).
//
// For every venue, run the clusterer over unattached tangential_signals,
// then run the resolver over unresolved candidate_identities. Idempotent —
// signals already attached to a candidate are skipped, candidates already
// resolved are skipped. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-phase-b.ts                 # all venues, AI on (prompts before running)
//   npx tsx scripts/backfill-phase-b.ts --no-ai         # skip AI adjudicator (Tier 2 stays at needs_review)
//   npx tsx scripts/backfill-phase-b.ts --venue <uuid>  # one venue only
//   npx tsx scripts/backfill-phase-b.ts --platform the_knot  # one platform — applies to BOTH cluster and resolve
//   npx tsx scripts/backfill-phase-b.ts --yes           # skip confirmation prompt
//
// Reads tangential_signals + leads (weddings) → writes candidate_identities,
// attribution_events, wedding_touchpoints. RLS bypassed via service role.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { reclusterVenue } from '../src/lib/services/candidate-clusterer'
import { resolveVenueCandidates } from '../src/lib/services/candidate-resolver'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const venueArg = args.includes('--venue') ? args[args.indexOf('--venue') + 1] : null
const platformArg = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : undefined
const skipAI = args.includes('--no-ai')
const skipConfirm = args.includes('--yes')

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

async function main() {
  console.log('\n=== Phase B historical backfill ===\n')

  let venues: Array<{ id: string; name: string }>
  if (venueArg) {
    const { data } = await sb.from('venues').select('id, name').eq('id', venueArg).limit(1)
    venues = (data ?? []) as Array<{ id: string; name: string }>
  } else {
    const { data, error } = await sb.from('venues').select('id, name').is('archived_at', null).order('name')
    if (error) {
      console.error('venues fetch failed:', error.message)
      process.exit(1)
    }
    venues = (data ?? []) as Array<{ id: string; name: string }>
  }

  if (venues.length === 0) {
    console.log('no venues to process')
    return
  }
  console.log(`processing ${venues.length} venue(s)${platformArg ? ` (platform=${platformArg})` : ''}${skipAI ? ' (AI adjudicator OFF)' : ''}\n`)

  if (!skipConfirm) {
    const venueLabel = venues.length === 1
      ? venues[0].name
      : `${venues.length} venues (${venues.slice(0, 3).map((v) => v.name).join(', ')}${venues.length > 3 ? '...' : ''})`
    const answer = await prompt(`Run backfill against ${venueLabel}? (yes to proceed): `)
    if (answer !== 'yes') {
      console.log('cancelled')
      return
    }
    console.log()
  }

  let totalSignalsProcessed = 0
  let totalCandidatesCreated = 0
  let totalResolved = 0
  let totalDeferred = 0
  let totalConflicts = 0

  for (const v of venues) {
    console.log(`▸ ${v.name} (${v.id.slice(0, 8)})`)

    const clusterStats = await reclusterVenue({
      supabase: sb,
      venueId: v.id,
      platform: platformArg,
    })
    if (clusterStats.signals_processed === 0 && clusterStats.errors.length === 0) {
      console.log(`    cluster: 0 signals (already attached or none in venue)`)
    } else {
      console.log(
        `    cluster: ${clusterStats.signals_processed} processed, ` +
          `${clusterStats.signals_creating_new_cluster} new clusters, ` +
          `${clusterStats.signals_attached_to_existing} attached, ` +
          `${clusterStats.candidates_flagged_for_review} flagged for review, ` +
          `${clusterStats.signals_skipped_anonymous} anonymous skipped`,
      )
      if (clusterStats.errors.length > 0) {
        console.log(`    cluster errors: ${clusterStats.errors.length}`)
        for (const e of clusterStats.errors.slice(0, 3)) console.log(`      - ${e}`)
      }
    }

    const resolverStats = await resolveVenueCandidates({
      supabase: sb,
      venueId: v.id,
      platform: platformArg,
      skipAI,
    })
    if (resolverStats.candidates_processed === 0 && resolverStats.errors.length === 0) {
      console.log(`    resolve: 0 unresolved candidates`)
    } else {
      const resolved =
        resolverStats.resolved_tier_1_exact +
        resolverStats.resolved_tier_1_name_window +
        resolverStats.resolved_tier_1_full_name +
        resolverStats.resolved_tier_2_ai
      console.log(
        `    resolve: ${resolverStats.candidates_processed} processed, ` +
          `${resolved} matched (T1 exact=${resolverStats.resolved_tier_1_exact}, ` +
          `T1 name+win=${resolverStats.resolved_tier_1_name_window}, ` +
          `T1 full=${resolverStats.resolved_tier_1_full_name}, ` +
          `T2 AI=${resolverStats.resolved_tier_2_ai}), ` +
          `${resolverStats.deferred_to_ai} deferred, ` +
          `${resolverStats.no_match} no match, ` +
          `${resolverStats.conflicts_flagged} conflicts`,
      )
      if (resolverStats.errors.length > 0) {
        console.log(`    resolve errors: ${resolverStats.errors.length}`)
        for (const e of resolverStats.errors.slice(0, 3)) console.log(`      - ${e}`)
      }
    }

    totalSignalsProcessed += clusterStats.signals_processed
    totalCandidatesCreated += clusterStats.signals_creating_new_cluster
    totalResolved +=
      resolverStats.resolved_tier_1_exact +
      resolverStats.resolved_tier_1_name_window +
      resolverStats.resolved_tier_1_full_name +
      resolverStats.resolved_tier_2_ai
    totalDeferred += resolverStats.deferred_to_ai
    totalConflicts += resolverStats.conflicts_flagged
  }

  console.log('\n=== summary ===')
  console.log(`  venues:                ${venues.length}`)
  console.log(`  signals processed:     ${totalSignalsProcessed}`)
  console.log(`  new candidates:        ${totalCandidatesCreated}`)
  console.log(`  resolved to weddings:  ${totalResolved}`)
  console.log(`  deferred to coord/AI:  ${totalDeferred}`)
  console.log(`  conflicts flagged:     ${totalConflicts}`)
  console.log('\n=== done ===\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
