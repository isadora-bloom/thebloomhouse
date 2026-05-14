/**
 * Cross-source journey narrative service (Phase C / PC.3).
 *
 * Generates a one-to-two sentence narrative describing a couple's
 * full discovery + engagement journey across platforms. Reads from
 * candidate_identities, tangential_signals, attribution_events,
 * wedding_touchpoints, interactions, and the wedding row itself.
 * Asks Claude to compose the narrative; caches into
 * wedding_journey_narratives.
 *
 * Cache lifecycle:
 *   - generateOrFetch(weddingId, force=false) — returns cached if
 *     fresh, generates otherwise
 *   - "fresh" = current signal_count and attribution_count for the
 *     wedding's resolved candidates match the snapshot stored at
 *     last generation, ±2
 *   - pinned=true rows are never regenerated automatically
 *
 * Cost target: ~$0.005-0.01 per generation (Sonnet, ~300 token in,
 * ~200 token out).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, CLAUDE_MODEL } from '@/lib/ai/client'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import { buildCoordinatorPrompt } from '@/lib/ai/coordinator-prompt'
import { loadAutoContextForWedding } from '@/lib/services/identity/auto-context-loader'
import { redactError } from '@/lib/observability/redact'

// 2026-05-09 LLM-CALL-INVENTORY personality drift #3: bumped to v2.0
// when migrated to the canonical coordinator-prompt assembler.
//
// 2026-05-09 Wave 1B: bumped to v2.1. Couple's auto-context notes now
// flow into the journey narrative system prompt so the cross-source
// prose can describe the discovery sequence with awareness of the
// couple's emotional context. Same factual contract (chronology +
// platforms + first-touch attribution remain intact); the narrative
// voice is shaped by the soft layer when present. Cache invalidation
// is intentional via the wedding_journey_narratives staleness gate.
export const JOURNEY_NARRATIVE_PROMPT_VERSION = 'journey-narrative.prompt.v2.1'

const STALENESS_DELTA = 2
const GEN_LOCK_TTL_MS = 60_000 // 60s — generation that takes longer than this is assumed crashed

export interface JourneyNarrative {
  text: string
  cached: boolean
  generated_at: string
  signal_count: number
  attribution_count: number
  pinned: boolean
  /** True when another request is currently generating; the widget
   *  should poll briefly instead of triggering a duplicate AI call. */
  generating?: boolean
}

interface SignalRow {
  id: string
  signal_date: string | null
  action_class: string | null
  source_platform: string | null
  candidate_identity_id: string | null
}

interface AttributionRow {
  signal_id: string | null
  source_platform: string
  decided_at: string
  is_first_touch: boolean
  bucket: string
  tier: string
  reasoning: string | null
}

interface WeddingForNarrative {
  id: string
  venue_id: string
  source: string | null
  inquiry_date: string | null
  tour_date: string | null
  status: string | null
}

interface PersonRow {
  first_name: string | null
  last_name: string | null
}

async function fetchContext(supabase: SupabaseClient, weddingId: string) {
  const { data: wed } = await supabase
    .from('weddings')
    .select('id, venue_id, source, inquiry_date, tour_date, status')
    .eq('id', weddingId)
    .single()
  if (!wed) return null
  const wedding = wed as WeddingForNarrative

  const { data: candidatesRaw } = await supabase
    .from('candidate_identities')
    .select('id, source_platform, signal_count, funnel_depth')
    .eq('resolved_wedding_id', weddingId)
    .is('deleted_at', null)
  const candidates = (candidatesRaw ?? []) as Array<{ id: string; source_platform: string; signal_count: number; funnel_depth: number }>
  const candidateIds = candidates.map((c) => c.id)

  let signals: SignalRow[] = []
  if (candidateIds.length > 0) {
    const CHUNK = 100
    for (let i = 0; i < candidateIds.length; i += CHUNK) {
      const chunk = candidateIds.slice(i, i + CHUNK)
      const { data } = await supabase
        .from('tangential_signals')
        .select('id, signal_date, action_class, source_platform, candidate_identity_id')
        .in('candidate_identity_id', chunk)
        .order('signal_date', { ascending: true })
      signals.push(...((data ?? []) as SignalRow[]))
    }
  }

  // Pattern A (mig 336): live view filters reverted + tombstoned so
  // Sage's journey narrative reflects deduped attributions, not the
  // inflated counts that triggered the Round 2 audit.
  const { data: attribRaw } = await supabase
    .from('attribution_events_live')
    .select('signal_id, source_platform, decided_at, is_first_touch, bucket, tier, reasoning')
    .eq('wedding_id', weddingId)
  const attributions = (attribRaw ?? []) as AttributionRow[]

  const { data: peopleRaw } = await supabase
    .from('people')
    .select('first_name, last_name')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])
  const people = (peopleRaw ?? []) as PersonRow[]

  // Recent email subjects (limit 5 most recent — for the inquiry-channel hint).
  const { data: subjects } = await supabase
    .from('interactions')
    .select('subject, created_at')
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })
    .limit(5)
  const interactionSubjects = ((subjects ?? []) as Array<{ subject: string | null }>)
    .map((s) => s.subject)
    .filter((s): s is string => Boolean(s))

  // Computed inquiry channel — the touchpoint mapper has already
  // identified WHICH channel the inquiry actually came in on
  // (e.g. 'calendly' for a Calendly-routed lead). The wedding.source
  // field is the LEGACY first-touch which can be stale or wrong
  // (e.g. 'website' on a Calendly inquiry). Pass both so the AI can
  // describe the actual channel without conflating with legacy.
  const { data: inqTp } = await supabase
    .from('wedding_touchpoints')
    .select('source')
    .eq('wedding_id', weddingId)
    .eq('touch_type', 'inquiry')
    .order('occurred_at', { ascending: true })
    .limit(1)
  const computedInquirySource = ((inqTp?.[0] as { source: string | null } | undefined)?.source) ?? null

  return {
    wedding,
    candidates,
    signals,
    attributions,
    people,
    interactionSubjects,
    computedInquirySource,
    signal_count: signals.length,
    attribution_count: attributions.filter((a) => !a.bucket || a.bucket).length,
  }
}

function buildUserPrompt(ctx: NonNullable<Awaited<ReturnType<typeof fetchContext>>>): string {
  const { wedding, candidates, signals, attributions, people, interactionSubjects, computedInquirySource } = ctx
  // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name so the AI
  // narrative doesn't refer to the same human twice (Knot proxy +
  // real Gmail rows for one human).
  const couple = dedupePeopleByName(people.filter((p) => p.first_name))
    .map((p) => `${p.first_name}${p.last_name ? ' ' + p.last_name : ''}`)
    .join(' & ') || 'this couple'

  const lines: string[] = []
  lines.push(`COUPLE: ${couple}`)
  lines.push(`STATUS: ${wedding.status ?? 'unknown'}`)
  if (wedding.inquiry_date) lines.push(`INQUIRY_DATE: ${wedding.inquiry_date.slice(0, 10)}`)
  if (wedding.tour_date) lines.push(`TOUR_DATE: ${wedding.tour_date.slice(0, 10)}`)
  // INQUIRY_CHANNEL is the actual channel the inquiry arrived on
  // (e.g. 'calendly'). Use this when describing how the couple
  // reached out. LEGACY_SOURCE is the wedding.source field, which
  // may be stale or wrong — included only as a hint when there's
  // a conflict between computed and legacy.
  if (computedInquirySource) lines.push(`INQUIRY_CHANNEL: ${computedInquirySource}`)
  if (wedding.source && wedding.source !== computedInquirySource) {
    lines.push(`LEGACY_SOURCE: ${wedding.source}  (note: this disagrees with INQUIRY_CHANNEL — prefer INQUIRY_CHANNEL when describing how they reached out)`)
  }
  lines.push('')
  lines.push('PLATFORM CANDIDATES (one per platform that matched this couple):')
  for (const c of candidates) {
    lines.push(`  - ${c.source_platform}: ${c.signal_count} signals, funnel depth ${c.funnel_depth}`)
  }
  lines.push('')
  lines.push('SIGNAL TIMELINE (chronological):')
  for (const s of signals) {
    const date = s.signal_date?.slice(0, 10) ?? '?'
    lines.push(`  ${date} — ${s.source_platform}: ${s.action_class ?? 'event'}`)
  }
  lines.push('')
  if (attributions.length > 0) {
    lines.push('ATTRIBUTION DECISIONS:')
    for (const a of attributions) {
      const ft = a.is_first_touch ? 'FIRST-TOUCH' : a.bucket
      lines.push(`  ${a.decided_at.slice(0, 10)} — ${a.source_platform} [${ft}, tier ${a.tier}]${a.reasoning ? ': ' + a.reasoning : ''}`)
    }
    lines.push('')
  }
  if (interactionSubjects.length > 0) {
    lines.push('RECENT EMAIL SUBJECTS:')
    for (const s of interactionSubjects) lines.push(`  "${s}"`)
  }
  return lines.join('\n')
}

const TASK_INSTRUCTIONS = `Write one-to-two sentence narrative summaries of wedding-couple discovery journeys for venue coordinators.

Input describes a couple, their inquiry/tour dates, the platform signals our system has captured (Knot views, Instagram follows, Pinterest saves, etc.), and the attribution decisions our matcher made.

Your output is a SINGLE PARAGRAPH (one or two sentences) that:
- Names the couple naturally
- Describes the chronological discovery sequence using actual dates
- When describing how they reached out, USE the INQUIRY_CHANNEL value
  if present (it's the computed channel from the inquiry touchpoint,
  e.g. 'calendly'). DO NOT use LEGACY_SOURCE for this, it can be
  stale and disagree with the computed channel.
- Mentions the platforms involved and the engagement type (viewed, saved, messaged, followed, etc.)
- Only call something "first-touch" if the input ATTRIBUTION DECISIONS
  section explicitly flags it FIRST-TOUCH. If no row says FIRST-TOUCH,
  do NOT claim first-touch credit; describe the signals as engagement
  rather than attribution.
- Pay attention to chronology: signals BEFORE the inquiry are
  attribution, signals AFTER are post-inquiry browsing, describe
  them differently. Post-inquiry browsing on a vendor platform is a
  comparison-shopping signal, not first-touch credit.
- If a recent email subject mentions "saw you on X" or similar, weave it in as confirming evidence
- Never invent dates or platforms not in the input
- Use natural prose, no bullet points, no headers, no markdown
- 50-100 words max
- If a COUPLE'S NOTES block is in the system prompt, those notes
  shape the TONE of the narrative (warmth, gravity, brevity), NOT
  its facts. Never quote the notes; never reference grief, health,
  or financial-stress markers explicitly. The narrative reads as
  "Bloom knows this couple" only because the prose feels
  appropriately tuned, never because soft-context appears in the
  output.

Examples of good output:

"Sarah Reynolds first viewed your Knot listing on March 12, came back twice over the next two days, and saved it on March 13. She also followed your Instagram on March 14. The inquiry email arrived March 20, first-touch credit goes to The Knot, six days before she reached out."

"Mark and Jenna have been quiet since their March 18 inquiry but were active on Pinterest before, they saved your venue twice in early March. Pinterest is the first-touch source even though the inquiry came through your website form."

"Ryan Schubert and Madison Bryant booked a tour through Calendly on March 29 and toured the venue on April 13. Madison came back to The Knot the next day to save and view your listing again, post-tour comparison browsing rather than first-touch attribution."

Return ONLY the narrative text. No JSON, no quotes around it, no explanation.`

export async function generateNarrativeText(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ text: string; signal_count: number; attribution_count: number; venue_id: string } | null> {
  const ctx = await fetchContext(supabase, weddingId)
  if (!ctx) return null
  if (ctx.candidates.length === 0) return null

  const userPrompt = buildUserPrompt(ctx)
  // Wave 1B (2026-05-09). Load couple-notes as tone fuel for the
  // journey narrative. limit=8 — narrators have a tighter context
  // budget than the brain reply path. Best-effort: the loader never
  // throws (returns brainBlock=null on any error); this try/catch is
  // defense-in-depth so a journey narrative without soft-context still
  // produces valid prose (just without the life-context-aware framing).
  let coupleNotesBlock: string | null = null
  try {
    const auto = await loadAutoContextForWedding(supabase, weddingId, { limit: 8 })
    coupleNotesBlock = auto.brainBlock
  } catch (err) {
    console.warn('[journey-narrative] auto-context load failed:', redactError(err))
  }
  const { systemPrompt, promptVersion, contentTier } = await buildCoordinatorPrompt({
    venueId: ctx.wedding.venue_id,
    surface: 'journey_narrative',
    taskInstructions: TASK_INSTRUCTIONS,
    coupleNotesBlock,
    contentTier: 1,
  })
  const result = await callAI({
    systemPrompt,
    userPrompt,
    maxTokens: 300,
    temperature: 0.4,
    venueId: ctx.wedding.venue_id,
    taskType: 'journey_narrative',
    promptVersion,
    contentTier,
  })

  // PC.4 fix #9: AI sometimes wraps the paragraph in quotes despite
  // the prompt's instruction not to. Strip a single matched pair of
  // surrounding quotes (curly or straight) without disturbing
  // intentional dialogue inside the narrative. [\s\S] used in place
  // of the `s` regex flag, which is es2018+.
  let text = result.text.trim()
  text = text.replace(/^["'“‘]([\s\S]*)["'”’]$/, '$1').trim()

  return {
    text,
    signal_count: ctx.signal_count,
    attribution_count: ctx.attribution_count,
    venue_id: ctx.wedding.venue_id,
  }
}

/**
 * Cache-only fetch. Returns existing row when present, null when
 * the wedding has no narrative yet. Never invokes Claude. Used by
 * Sage's draft path (PD.1 fix #3 — 2026-04-30) so first-draft
 * latency on a fresh lead doesn't pay an in-line AI call. Lead
 * detail page still uses generateOrFetch which has the lazy-gen
 * behavior.
 */
export async function fetchCachedNarrative(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<JourneyNarrative | null> {
  const { data } = await supabase
    .from('wedding_journey_narratives')
    .select('narrative_text, signal_count_at_generation, attribution_count_at_generation, generated_at, pinned, generating_at')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  const row = data as
    | {
        narrative_text: string
        signal_count_at_generation: number
        attribution_count_at_generation: number
        generated_at: string
        pinned: boolean
        generating_at: string | null
      }
    | null
  if (!row || !row.narrative_text) return null
  return {
    text: row.narrative_text,
    cached: true,
    generated_at: row.generated_at,
    signal_count: row.signal_count_at_generation,
    attribution_count: row.attribution_count_at_generation,
    pinned: row.pinned,
    generating: Boolean(row.generating_at),
  }
}

/**
 * Lazy fetch-or-generate. Returns cached row when fresh; otherwise
 * regenerates. force=true bypasses the freshness check (used by an
 * explicit "regenerate" button).
 */
export async function generateOrFetch(
  supabase: SupabaseClient,
  weddingId: string,
  force = false,
): Promise<JourneyNarrative | null> {
  const { data: existingRaw } = await supabase
    .from('wedding_journey_narratives')
    .select('id, narrative_text, signal_count_at_generation, attribution_count_at_generation, generated_at, pinned, generating_at')
    .eq('wedding_id', weddingId)
    .single()
  const existing = existingRaw as
    | {
        id: string
        narrative_text: string
        signal_count_at_generation: number
        attribution_count_at_generation: number
        generated_at: string
        pinned: boolean
        generating_at: string | null
      }
    | null

  // PC.4 fix #5: if another request is mid-generation for this
  // wedding, return generating=true so the caller can poll instead
  // of double-charging Claude. Lock is considered stale after
  // GEN_LOCK_TTL_MS; a crashed gen doesn't permanently wedge the row.
  if (existing && existing.generating_at && !force) {
    const age = Date.now() - new Date(existing.generating_at).getTime()
    if (age < GEN_LOCK_TTL_MS) {
      return {
        text: existing.narrative_text || '',
        cached: true,
        generated_at: existing.generated_at,
        signal_count: existing.signal_count_at_generation,
        attribution_count: existing.attribution_count_at_generation,
        pinned: existing.pinned,
        generating: true,
      }
    }
  }

  if (existing && existing.pinned && !force) {
    return {
      text: existing.narrative_text,
      cached: true,
      generated_at: existing.generated_at,
      signal_count: existing.signal_count_at_generation,
      attribution_count: existing.attribution_count_at_generation,
      pinned: true,
    }
  }

  if (existing && !force) {
    // Pattern A (mig 336): an explicit bust signal is checked first.
    // Pre-336 the only freshness check was attribution-count drift,
    // which catches INCREASES but not the DECREASE from dedup. Mass
    // mutations (Pattern A dedup, mergeWeddings, wave-7B reclassify)
    // now set weddings.narrative_cache_busted_at to force regen even
    // when the count stays the same or drops.
    const { data: wedFresh } = await supabase
      .from('weddings')
      .select('narrative_cache_busted_at')
      .eq('id', weddingId)
      .maybeSingle()
    const bustedAt = (wedFresh as { narrative_cache_busted_at: string | null } | null)
      ?.narrative_cache_busted_at
    const cacheIsBusted =
      bustedAt &&
      existing.generated_at &&
      new Date(bustedAt).getTime() > new Date(existing.generated_at).getTime()

    // Cheap freshness check: does the wedding still have ~the same
    // attribution count as when we generated? Uses the live view so
    // tombstoned rows don't keep the cache valid past dedup.
    const { count: currentAttribs } = await supabase
      .from('attribution_events_live')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
    if (
      !cacheIsBusted &&
      typeof currentAttribs === 'number' &&
      Math.abs(currentAttribs - existing.attribution_count_at_generation) <= STALENESS_DELTA
    ) {
      return {
        text: existing.narrative_text,
        cached: true,
        generated_at: existing.generated_at,
        signal_count: existing.signal_count_at_generation,
        attribution_count: existing.attribution_count_at_generation,
        pinned: existing.pinned,
      }
    }
  }

  // PC.4 fix #5: claim the lock BEFORE calling Claude so concurrent
  // requests see generating_at and back off. We need a venue_id to
  // upsert; fetch it cheaply if no existing row.
  let venueIdForLock: string | null = null
  if (existing) {
    // We don't carry venue_id on the existing fetch above to keep it
    // narrow; pull it from weddings.
    const { data: wed } = await supabase.from('weddings').select('venue_id').eq('id', weddingId).single()
    venueIdForLock = ((wed as { venue_id: string } | null)?.venue_id) ?? null
  }
  if (!venueIdForLock) {
    const { data: wed } = await supabase.from('weddings').select('venue_id').eq('id', weddingId).single()
    venueIdForLock = ((wed as { venue_id: string } | null)?.venue_id) ?? null
  }
  if (venueIdForLock) {
    await supabase
      .from('wedding_journey_narratives')
      .upsert(
        {
          ...(existing ? { id: existing.id } : {}),
          venue_id: venueIdForLock,
          wedding_id: weddingId,
          narrative_text: existing?.narrative_text ?? '',
          signal_count_at_generation: existing?.signal_count_at_generation ?? 0,
          attribution_count_at_generation: existing?.attribution_count_at_generation ?? 0,
          generating_at: new Date().toISOString(),
        },
        { onConflict: 'wedding_id' },
      )
  }

  const generated = await generateNarrativeText(supabase, weddingId)
  if (!generated) {
    // Clear the lock so a future call can retry instead of hitting
    // the lock window for 60s on a wedding that legitimately has
    // nothing to narrate.
    if (existing) {
      await supabase
        .from('wedding_journey_narratives')
        .update({ generating_at: null })
        .eq('id', existing.id)
    }
    return null
  }

  await supabase
    .from('wedding_journey_narratives')
    .upsert(
      {
        ...(existing ? { id: existing.id } : {}),
        venue_id: generated.venue_id,
        wedding_id: weddingId,
        narrative_text: generated.text,
        signal_count_at_generation: generated.signal_count,
        attribution_count_at_generation: generated.attribution_count,
        // Persist the exact model used so audits stay in lockstep with
        // the live brain-call constant. Pre-fix this was 'claude-sonnet-4'
        // and drifted every Sonnet bump. OPS-21.5.2.
        model: CLAUDE_MODEL,
        generated_at: new Date().toISOString(),
        generated_by: force ? 'coordinator' : 'auto',
        generating_at: null, // release the lock
      },
      { onConflict: 'wedding_id' },
    )

  return {
    text: generated.text,
    cached: false,
    generated_at: new Date().toISOString(),
    signal_count: generated.signal_count,
    attribution_count: generated.attribution_count,
    // A fresh generation never carries a stale pin — explicit pin
    // step is the user's separate action.
    pinned: existing?.pinned ?? false,
  }
}
