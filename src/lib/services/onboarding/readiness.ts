/**
 * Pre-Go-Live readiness evaluator (T5-W5).
 *
 * Combines the 8 (now 14 — see runDataIntegrityChecks) strict
 * structural invariants with 4 softer smoke tests that flag patterns
 * which often, but not always, indicate something is wrong.
 *
 * Extracted from scripts/onboarding-readiness.ts (kept as a thin CLI
 * wrapper) so a coordinator can run + persist the verdict from
 * POST /api/onboarding/project/readiness with no terminal.
 * recordReadinessEvaluation (src/lib/services/onboarding/project.ts)
 * has existed with zero callers since it landed — this is the first
 * writer.
 *
 * A venue should not be enabled for production use unless ALL
 * invariants pass. Smoke tests are advisory — coordinator reviews,
 * doesn't auto-block.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { runDataIntegrityChecks, type InvariantResult } from '@/lib/services/data-integrity'

export interface SmokeTest {
  id: string
  name: string
  /** 'pass' = looks healthy. 'warn' = unusual but not necessarily wrong. 'fail' = strong signal something is broken. */
  status: 'pass' | 'warn' | 'fail'
  /** Free-form observation for the coordinator. */
  message: string
}

export interface ReadinessReport {
  venueId: string
  invariants: InvariantResult[]
  smoke: SmokeTest[]
  invariantsClean: boolean
  smokeFails: number
  smokeWarns: number
  /**
   * Gate verdict — mirrors the CLI's exit-code semantics (`process.exit(invariantsClean ? 0 : 1)`
   * in the original script). Structural invariants are the hard gate; smoke tests are
   * advisory and never block even when they fail — the coordinator reviews the messages.
   */
  readyForGoLive: boolean
  evaluatedAt: string
}

async function smokeWeddingsExist(sb: SupabaseClient, venueId: string): Promise<SmokeTest> {
  const { count } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
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

async function smokeRecentActivity(sb: SupabaseClient, venueId: string): Promise<SmokeTest> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
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

async function smokeHeatDistribution(sb: SupabaseClient, venueId: string): Promise<SmokeTest> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('heat_score, temperature_tier')
    .eq('venue_id', venueId)
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

async function smokeSourceMix(sb: SupabaseClient, venueId: string): Promise<SmokeTest> {
  const { data: weddings } = await sb
    .from('weddings')
    .select('source')
    .eq('venue_id', venueId)
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

/**
 * Run every invariant + smoke test for a venue. Pure read — no writes.
 * Caller (the API route, or the CLI wrapper) decides whether to
 * persist the verdict via recordReadinessEvaluation.
 */
export async function evaluateReadiness(
  sb: SupabaseClient,
  venueId: string,
): Promise<ReadinessReport> {
  const invariants = await runDataIntegrityChecks(sb, venueId)
  const smoke = await Promise.all([
    smokeWeddingsExist(sb, venueId),
    smokeRecentActivity(sb, venueId),
    smokeHeatDistribution(sb, venueId),
    smokeSourceMix(sb, venueId),
  ])

  const invariantsClean = invariants.every((i) => i.count === 0)
  const smokeFails = smoke.filter((s) => s.status === 'fail').length
  const smokeWarns = smoke.filter((s) => s.status === 'warn').length

  return {
    venueId,
    invariants,
    smoke,
    invariantsClean,
    smokeFails,
    smokeWarns,
    readyForGoLive: invariantsClean,
    evaluatedAt: new Date().toISOString(),
  }
}
