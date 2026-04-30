// Pre-Go-Live readiness report. Combines:
//   1. The 8 strict structural invariants (data-integrity)
//   2. 4 smoke tests for "this venue's data shape looks reasonable"
//
// Run after onboard-data-cleanup.ts. A venue should not be enabled
// for production use unless ALL invariants pass and the smoke tests
// land in expected ranges.
//
// Smoke tests are softer than invariants — they flag patterns that
// often (but not always) indicate something is wrong. Coordinator
// reviews them; doesn't auto-block.
//
// Usage:
//   npx tsx scripts/onboarding-readiness.ts --venue <uuid>
//   npx tsx scripts/onboarding-readiness.ts --venue <uuid> --json
//
// Exit codes:
//   0 — all invariants pass; smoke tests are advisory
//   1 — invariants violated (block Go Live)
//   2 — script error
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runDataIntegrityChecks } from '../src/lib/services/data-integrity'

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
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null
const asJson = args.includes('--json')
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}

interface SmokeTest {
  id: string
  name: string
  /** 'pass' = looks healthy. 'warn' = unusual but not necessarily wrong. 'fail' = strong signal something is broken. */
  status: 'pass' | 'warn' | 'fail'
  /** Free-form observation for the coordinator. */
  message: string
}

async function smokeWeddingsExist(): Promise<SmokeTest> {
  const { count } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId!)
  const c = count ?? 0
  return {
    id: 'weddings_present',
    name: 'Venue has at least one wedding',
    status: c > 0 ? 'pass' : 'warn',
    message: c > 0
      ? `${c} weddings on file`
      : 'No weddings yet — fine for a brand-new venue, but verify the email pipeline is connected.',
  }
}

async function smokeRecentActivity(): Promise<SmokeTest> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId!)
    .gte('timestamp', sevenDaysAgo)
  const c = count ?? 0
  if (c === 0) {
    return {
      id: 'recent_activity',
      name: 'Recent inbox activity (last 7 days)',
      status: 'warn',
      message: 'No interactions in the last 7 days. Either Gmail is disconnected, the venue truly has no leads, or the ingest cron is broken. Check gmail_connections.status.',
    }
  }
  return {
    id: 'recent_activity',
    name: 'Recent inbox activity (last 7 days)',
    status: 'pass',
    message: `${c} interactions in the last 7 days`,
  }
}

async function smokeHeatDistribution(): Promise<SmokeTest> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('heat_score, temperature_tier')
    .eq('venue_id', venueId!)
    .neq('status', 'completed')
    .neq('status', 'lost')
    .neq('status', 'cancelled')
  const rows = (weddings ?? []) as Array<{ heat_score: number; temperature_tier: string }>
  const total = rows.length
  if (total === 0) {
    return {
      id: 'heat_distribution',
      name: 'Heat-score distribution looks reasonable',
      status: 'pass',
      message: 'No active leads to distribute (skipped).',
    }
  }
  const hot = rows.filter((r) => r.temperature_tier === 'hot').length
  const cold = rows.filter((r) => r.temperature_tier === 'cold').length
  const hotPct = hot / total
  const coldPct = cold / total
  // Heuristic: "everything hot" or "everything cold" indicates either
  // false-positive heat events (signal-inference firing on Sage's
  // own outbounds — see direction_from_venue_own invariant) or a
  // missing decay job. Healthy distribution is 5-25% hot, 30-70% warm,
  // 20-50% cold.
  if (hotPct > 0.5) {
    return {
      id: 'heat_distribution',
      name: 'Heat-score distribution looks reasonable',
      status: 'fail',
      message: `${Math.round(hotPct * 100)}% of active leads are 'hot'. Suggests heat is being inflated — investigate signal-inference false positives or check the heat_decay cron.`,
    }
  }
  if (coldPct > 0.9) {
    return {
      id: 'heat_distribution',
      name: 'Heat-score distribution looks reasonable',
      status: 'warn',
      message: `${Math.round(coldPct * 100)}% of active leads are 'cold'. Either the venue is genuinely quiet, or engagement events aren't firing — check email-pipeline applySignalInference.`,
    }
  }
  return {
    id: 'heat_distribution',
    name: 'Heat-score distribution looks reasonable',
    status: 'pass',
    message: `${total} active leads. Hot: ${hot} (${Math.round(hotPct * 100)}%). Cold: ${cold} (${Math.round(coldPct * 100)}%).`,
  }
}

async function smokeSourceMix(): Promise<SmokeTest> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('source')
    .eq('venue_id', venueId!)
  const rows = (weddings ?? []) as Array<{ source: string | null }>
  const counts = new Map<string, number>()
  for (const r of rows) {
    const s = r.source ?? 'unknown'
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  if (rows.length === 0) {
    return {
      id: 'source_mix',
      name: 'Wedding source-attribution looks reasonable',
      status: 'pass',
      message: 'No weddings (skipped).',
    }
  }
  const sortedSources = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  const dominantPct = sortedSources[0][1] / rows.length
  // Heuristic: if 95%+ of weddings share one source, attribution is
  // probably defaulting somewhere — typical pattern when the email
  // pipeline can't extract a real source and falls back to 'website'
  // or 'direct' for everything.
  if (dominantPct > 0.95 && sortedSources[0][0] !== 'unknown') {
    return {
      id: 'source_mix',
      name: 'Wedding source-attribution looks reasonable',
      status: 'warn',
      message: `${Math.round(dominantPct * 100)}% of weddings have source='${sortedSources[0][0]}'. Real venues typically see 4-6 different sources. Investigate whether source detection is defaulting (form-relay parser misses, source=null fallbacks).`,
    }
  }
  const summary = sortedSources.slice(0, 5).map(([s, c]) => `${s}=${c}`).join(', ')
  return {
    id: 'source_mix',
    name: 'Wedding source-attribution looks reasonable',
    status: 'pass',
    message: `${rows.length} weddings across ${counts.size} sources: ${summary}.`,
  }
}

async function main() {
  if (!asJson) {
    console.log(`\n=== Onboarding readiness — venue ${venueId} ===\n`)
  }

  const invariants = await runDataIntegrityChecks(sb, venueId!)
  const smoke = await Promise.all([
    smokeWeddingsExist(),
    smokeRecentActivity(),
    smokeHeatDistribution(),
    smokeSourceMix(),
  ])

  const invariantsClean = invariants.every((i) => i.count === 0)
  const smokeFails = smoke.filter((s) => s.status === 'fail').length
  const smokeWarns = smoke.filter((s) => s.status === 'warn').length

  if (asJson) {
    console.log(JSON.stringify({
      venueId,
      invariants_clean: invariantsClean,
      ready_for_go_live: invariantsClean && smokeFails === 0,
      invariants,
      smoke,
    }, null, 2))
  } else {
    console.log('STRUCTURAL INVARIANTS (must all pass)')
    for (const i of invariants) {
      const status = i.count === 0 ? '✓' : '✗'
      console.log(`  ${status} ${i.count.toString().padStart(4)}  ${i.name}`)
    }
    console.log('\nSMOKE TESTS (advisory)')
    for (const s of smoke) {
      const sym = s.status === 'pass' ? '✓' : s.status === 'warn' ? '!' : '✗'
      console.log(`  ${sym}  ${s.name}`)
      console.log(`         ${s.message}`)
    }
    console.log()
    if (invariantsClean && smokeFails === 0 && smokeWarns === 0) {
      console.log('READY FOR GO LIVE — all invariants pass and all smoke tests are healthy.')
    } else if (invariantsClean && smokeFails === 0) {
      console.log(`READY FOR GO LIVE (with caveats) — invariants pass, but ${smokeWarns} smoke test${smokeWarns === 1 ? '' : 's'} flagged advisory warnings. Coordinator should review the messages above before activating.`)
    } else if (invariantsClean) {
      console.log(`NOT READY — invariants pass but ${smokeFails} smoke test${smokeFails === 1 ? '' : 's'} indicate likely breakage. Investigate before Go Live.`)
    } else {
      console.log('NOT READY — one or more invariants violated. Run scripts/onboard-data-cleanup.ts --apply to repair, then re-run this report.')
    }
  }

  process.exit(invariantsClean ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(2) })
