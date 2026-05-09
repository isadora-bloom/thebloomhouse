/**
 * TRENDS-DIAGNOSIS Fix 3 / Finding A (2026-05-09): LLM cultural-moments
 * proposer.
 *
 * The legacy proposer (`cultural-moments-auto-propose.ts`) is a
 * statistical z-score detector running over Google-Trends weekly
 * series. It titles spikes generically ("Wedding-search demand spike",
 * "Engagement-intent spike (3-12mo pipeline)", "Sentiment headwind:
 * divorce-search uptick") and never names the actual cultural event
 * driving the spike — coordinators see a queue of templated headlines
 * they have no good way to act on.
 *
 * This module is the JUDGEMENT-WORK proposer: a Sonnet call that
 * proposes 0-3 named cultural moments per venue per day with a
 * dateable window, an evidence URL, and a one-sentence rationale.
 * Examples: "Royal Wedding 2026", "cottagecore Pinterest peak",
 * "Taylor Swift / Travis Kelce engagement", "Memorial Day 2026
 * weather forecast volatility".
 *
 * Architecture:
 *   - Sonnet (judgement work — Haiku would template-flavor the output).
 *   - taskType `cultural_moments_propose` for cost-rollup attribution.
 *   - promptVersion `cultural-moments-llm-propose.v1` per OPS-21.5.1.
 *   - Per-venue dedup uses the SAME fingerprint helper as the
 *     statistical proposer, on (kind='llm_propose', title, weekStart)
 *     so the queue can't double-fire the same Royal Wedding 2026
 *     proposal across multiple ticks.
 *   - Inserts as `proposed_by='ai_llm'` (new value extending the CHECK
 *     constraint via migration 250). Status='proposed'. The existing
 *     `venue_cultural_moment_state` confirm/dismiss flow handles
 *     coordinator review unchanged.
 *   - Cost-ceiling gated. If gate is closed, skip silently — the
 *     statistical proposer still runs.
 *
 * The statistical proposer continues to run on its own schedule. The
 * two complement each other: statistical catches search-spike signals
 * the LLM might miss; LLM catches NAMED events that don't reduce to a
 * single search-term spike.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import {
  proposeFromAutoDetection,
  type CulturalMomentCategory,
} from '@/lib/services/external-context/cultural-moments'

export const CULTURAL_MOMENTS_LLM_PROPOSE_VERSION =
  'cultural-moments-llm-propose.v1'

const DAY_MS = 86_400_000

// Categories the cultural_moments table tracks. Matches the values the
// CulturalMomentCategory union and migration 139's check constraint
// support. The LLM is instructed to pick one per proposal.
const CATEGORY_LIST: ReadonlyArray<CulturalMomentCategory> = [
  'celebrity_wedding',
  'aesthetic_shift',
  'generational_milestone',
  'industry_news',
  'macro_event',
  'platform_event',
  'other',
]

interface LlmProposal {
  title: string
  category: CulturalMomentCategory
  date_range_start: string // YYYY-MM-DD
  date_range_end: string | null // YYYY-MM-DD or null for ongoing
  evidence_url: string | null
  rationale: string
}

interface LlmProposalResponse {
  proposals: LlmProposal[]
}

const SYSTEM_PROMPT = `You are an analyst for Bloom House, a wedding-venue intelligence platform. Your job is to surface NAMED cultural moments that plausibly affect wedding-search behaviour, so a venue coordinator can confirm or dismiss them.

CONTEXT:
- Wedding venues book 12-24 months ahead. A celebrity engagement that goes viral now lifts search volume for "engagement ring", "outdoor wedding venue", "rustic barn wedding" in the same week, then translates into venue inquiries 1-6 months later.
- Macro headwinds (rising mortgage rates, recession fear, election cycle uncertainty) compress wedding budgets and shrink guest counts.
- Aesthetic shifts (cottagecore, dark academia, coastal grandmother, dopamine dressing) drive Pinterest saves, then storefront views, then inquiries.
- Generational milestones (Taylor Swift / Travis Kelce engagement, princess weddings, royal family events) trigger emulation cycles in the 25-34 demographic that books the most wedding venues.

PROPOSAL CRITERIA — every moment you propose must meet ALL FIVE:
1. NAMED — has a specific identifying title a coordinator could search for.
2. DATEABLE — has a concrete start date and (when applicable) an end date.
3. PLAUSIBLY CONNECTED — there is a believable path from this moment to wedding-search behaviour. If you can't articulate it, do not propose.
4. EVIDENCE-AVAILABLE — you can cite a public URL (news outlet, official announcement, Pinterest trend report, FRED release, etc.). If you don't have a URL, do not propose.
5. RECENT — the moment is active or imminent in the last 30 days.

CATEGORIES — pick exactly one per proposal:
- celebrity_wedding — high-profile celebrity weddings, engagements, divorces.
- aesthetic_shift — design / styling / colour-palette trends.
- generational_milestone — TikTok-amplified events, viral life moments, royal events.
- industry_news — wedding-industry mergers, platform changes, vendor consolidation.
- macro_event — economic releases (CPI, mortgage rate moves, jobs reports), political events.
- platform_event — Instagram / Pinterest / TikTok algorithm changes, The Knot or WeddingWire policy changes.
- other — none of the above but clearly relevant.

OUTPUT — JSON only, exactly this shape:
{
  "proposals": [
    {
      "title": "Short, named, ≤80 chars",
      "category": "one of the categories above",
      "date_range_start": "YYYY-MM-DD",
      "date_range_end": "YYYY-MM-DD or null",
      "evidence_url": "https://... or null",
      "rationale": "One sentence: why this affects wedding-search behaviour"
    }
  ]
}

DISCIPLINE:
- 0 to 3 proposals per call. If nothing meets all five criteria, return {"proposals": []}.
- Do not invent dates or URLs. If unsure of the start date, do not propose.
- Do not propose moments older than 60 days unless they're still actively driving search behaviour.
- Do not propose generic categories ("summer 2026 weddings"); only specific named moments.
- Do not duplicate moments you've proposed in prior calls (the caller may surface known prior titles for you to avoid).`

interface ProposeArgs {
  supabase: SupabaseClient
  venueId: string
  /** State (lowercase 2-char). Used in the prompt for regional context. */
  venueState: string | null
  /** Existing proposed/confirmed titles for this venue from the last 60 days
   *  so the LLM can dedup against itself. Optional — caller may omit. */
  recentTitles?: string[]
}

interface ProposeResult {
  proposed: number
  deduped: number
  errors: number
  skipped: 'cost_ceiling' | 'no_state' | 'no_proposals' | null
  details: Array<{
    title: string
    outcome: 'proposed' | 'deduped' | 'error'
    momentId?: string
    error?: string
  }>
}

/**
 * Look up an existing AI-LLM-proposed cultural_moments row by exact title
 * + date_range_start. Returns the matching id (skip insert) or null
 * (proceed). Mirrors the statistical proposer's fingerprint pattern but
 * keys on the LLM-proposer-specific evidence.kind so the two pipelines
 * dedup independently.
 */
async function findExistingLlmProposalByTitle(
  supabase: SupabaseClient,
  title: string,
  startAt: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('cultural_moments')
    .select('id, title, evidence, status, start_at')
    .neq('status', 'dismissed')
    .gte('created_at', new Date(Date.now() - 60 * DAY_MS).toISOString())
    .limit(200)
  if (!data) return null
  for (const row of data as Array<{
    id: string
    title: string
    evidence: Record<string, unknown> | null
    start_at: string
  }>) {
    const ev = row.evidence ?? {}
    if (
      ev['kind'] === 'llm_propose' &&
      row.title?.trim().toLowerCase() === title.trim().toLowerCase() &&
      (row.start_at ?? '').slice(0, 10) === startAt.slice(0, 10)
    ) {
      return row.id
    }
  }
  return null
}

/**
 * Pull recent titles (proposed/confirmed) for the venue across both
 * proposers, so the LLM prompt can list them as "do not duplicate."
 */
async function getRecentVenueTitles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string[]> {
  // Per-venue confirmed/dismissed lives in venue_cultural_moment_state.
  // Pull moments with any decision in the last 60 days, plus globally
  // proposed-but-undecided rows (the LLM should avoid re-proposing
  // those too).
  const sinceIso = new Date(Date.now() - 60 * DAY_MS).toISOString()
  const [stateResult, proposedResult] = await Promise.all([
    supabase
      .from('venue_cultural_moment_state')
      .select('cultural_moments(title)')
      .eq('venue_id', venueId)
      .gte('decided_at', sinceIso)
      .limit(50),
    supabase
      .from('cultural_moments')
      .select('title')
      .eq('status', 'proposed')
      .gte('created_at', sinceIso)
      .limit(50),
  ])
  const titles = new Set<string>()
  type StateRow = {
    cultural_moments:
      | { title?: string }
      | Array<{ title?: string }>
      | null
  }
  for (const r of (stateResult.data ?? []) as StateRow[]) {
    const m = Array.isArray(r.cultural_moments)
      ? r.cultural_moments[0]
      : r.cultural_moments
    if (m?.title) titles.add(m.title)
  }
  for (const r of (proposedResult.data ?? []) as Array<{ title: string }>) {
    if (r.title) titles.add(r.title)
  }
  return Array.from(titles)
}

/**
 * Per-venue LLM proposal. Cost-ceiling gated; emits Sonnet call with
 * categorical schema; inserts each proposal as proposed_by='ai_llm'.
 */
export async function autoProposeCulturalMomentsLlm(
  args: ProposeArgs,
): Promise<ProposeResult> {
  const { supabase, venueId, venueState } = args
  const result: ProposeResult = {
    proposed: 0,
    deduped: 0,
    errors: 0,
    skipped: null,
    details: [],
  }

  // Cost-ceiling gate per OPS-21.4.3. Paused venues do not enter the
  // judgement-tier proposal path.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    result.skipped = 'cost_ceiling'
    return result
  }

  // No state → can't reason about regional events well. Statistical
  // proposer can still run nationally. Skip the LLM call.
  if (!venueState) {
    result.skipped = 'no_state'
    return result
  }

  const recentTitles =
    args.recentTitles ?? (await getRecentVenueTitles(supabase, venueId))
  const recentBlock =
    recentTitles.length > 0
      ? `\n\nALREADY-PROPOSED (do not duplicate; propose only if you have NEW evidence):\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
      : ''

  const todayIso = new Date().toISOString().slice(0, 10)
  const userPrompt = `Today's date: ${todayIso}.
Venue state: ${venueState.toUpperCase()} (${venueState.toLowerCase()}).
Allowed categories: ${CATEGORY_LIST.join(', ')}.

Propose 0-3 cultural moments active or imminent in the last 30 days for a wedding venue in ${venueState.toUpperCase()}. Apply all five criteria from the system prompt strictly. ${recentBlock}`

  let response: LlmProposalResponse
  try {
    response = await callAIJson<LlmProposalResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 800,
      temperature: 0.4,
      tier: 'sonnet',
      venueId,
      taskType: 'cultural_moments_propose',
      promptVersion: CULTURAL_MOMENTS_LLM_PROPOSE_VERSION,
      contentTier: 3, // No PII; the prompt only references geography + categories.
    })
  } catch (err) {
    result.errors += 1
    result.details.push({
      title: '<llm-call-failed>',
      outcome: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
    return result
  }

  const proposals = Array.isArray(response.proposals) ? response.proposals : []
  if (proposals.length === 0) {
    result.skipped = 'no_proposals'
    return result
  }

  for (const p of proposals) {
    // Per-proposal validation. Drop anything that doesn't meet the
    // five-criterion bar — the prompt asks for it but we enforce
    // structurally too.
    if (!p?.title?.trim() || p.title.length > 200) {
      result.errors += 1
      result.details.push({
        title: p?.title ?? '<empty>',
        outcome: 'error',
        error: 'invalid title',
      })
      continue
    }
    if (!p.date_range_start || !/^\d{4}-\d{2}-\d{2}$/.test(p.date_range_start)) {
      result.errors += 1
      result.details.push({
        title: p.title,
        outcome: 'error',
        error: 'invalid date_range_start',
      })
      continue
    }
    if (
      p.date_range_end &&
      !/^\d{4}-\d{2}-\d{2}$/.test(p.date_range_end)
    ) {
      result.errors += 1
      result.details.push({
        title: p.title,
        outcome: 'error',
        error: 'invalid date_range_end',
      })
      continue
    }
    if (!CATEGORY_LIST.includes(p.category)) {
      result.errors += 1
      result.details.push({
        title: p.title,
        outcome: 'error',
        error: `invalid category ${p.category}`,
      })
      continue
    }
    // Evidence URL is required by the prompt's criterion #4. If the
    // model returned null, drop — keeps the queue's quality high.
    if (!p.evidence_url) {
      result.errors += 1
      result.details.push({
        title: p.title,
        outcome: 'error',
        error: 'missing evidence_url',
      })
      continue
    }

    // Dedup against existing LLM-proposed rows for (title, start_at).
    const existing = await findExistingLlmProposalByTitle(
      supabase,
      p.title,
      p.date_range_start,
    )
    if (existing) {
      result.deduped += 1
      result.details.push({
        title: p.title,
        outcome: 'deduped',
        momentId: existing,
      })
      continue
    }

    // Insert via the existing propose helper, but with proposedBy='ai_llm'
    // to distinguish from the legacy z-score detector. Migration 250
    // extends the CHECK constraint to allow this value.
    const startAt = `${p.date_range_start}T00:00:00Z`
    const endAt = p.date_range_end ? `${p.date_range_end}T23:59:59Z` : null
    const inserted = await proposeFromAutoDetection(supabase, {
      title: p.title.trim(),
      description: `${p.rationale.trim()} Source: ${p.evidence_url}`,
      startAt,
      endAt,
      category: p.category,
      evidence: {
        kind: 'llm_propose',
        version: CULTURAL_MOMENTS_LLM_PROPOSE_VERSION,
        evidence_url: p.evidence_url,
        rationale: p.rationale,
        venue_state: venueState,
        proposedAt: new Date().toISOString(),
      },
      geoScope: null, // National default; coordinator can refine on confirm.
    })

    // The propose helper uses proposedBy='ai' by default. Update the
    // row to 'ai_llm' so /intel/cultural-moments queue can split the
    // two pipelines visually. (proposeMoment doesn't accept ai_llm
    // because the legacy CHECK constraint forbids it pre-migration-250;
    // we update post-insert under the new constraint.)
    if (inserted.ok) {
      await supabase
        .from('cultural_moments')
        .update({ proposed_by: 'ai_llm' })
        .eq('id', inserted.id)
      result.proposed += 1
      result.details.push({
        title: p.title,
        outcome: 'proposed',
        momentId: inserted.id,
      })
    } else {
      result.errors += 1
      result.details.push({
        title: p.title,
        outcome: 'error',
        error: inserted.error,
      })
    }
  }

  return result
}

/**
 * Cron-friendly batch wrapper: run the LLM proposer for every active
 * venue with state set. Mirrors the statistical proposer's all-venue
 * sweep but goes through cost-ceiling per call, so paused venues
 * silently skip.
 */
export async function autoProposeCulturalMomentsLlmAllVenues(
  supabase: SupabaseClient,
): Promise<{
  venuesChecked: number
  proposed: number
  deduped: number
  errors: number
  skipped: number
  perVenue: Array<{ venueId: string; result: ProposeResult }>
}> {
  const { data: venueRows } = await supabase
    .from('venues')
    .select('id, state')
    .eq('status', 'active')

  const venues = ((venueRows ?? []) as Array<{ id: string; state: string | null }>)

  const summary = {
    venuesChecked: venues.length,
    proposed: 0,
    deduped: 0,
    errors: 0,
    skipped: 0,
    perVenue: [] as Array<{ venueId: string; result: ProposeResult }>,
  }

  for (const v of venues) {
    try {
      const r = await autoProposeCulturalMomentsLlm({
        supabase,
        venueId: v.id,
        venueState: v.state ? v.state.trim().toLowerCase() : null,
      })
      summary.proposed += r.proposed
      summary.deduped += r.deduped
      summary.errors += r.errors
      if (r.skipped) summary.skipped += 1
      summary.perVenue.push({ venueId: v.id, result: r })
    } catch (err) {
      summary.errors += 1
      summary.perVenue.push({
        venueId: v.id,
        result: {
          proposed: 0,
          deduped: 0,
          errors: 1,
          skipped: null,
          details: [
            {
              title: '<orchestrator-error>',
              outcome: 'error',
              error: err instanceof Error ? err.message : String(err),
            },
          ],
        },
      })
    }
  }

  return summary
}
