/**
 * Bloom House — referenced couple resolver.
 *
 * Triggered when the inbound-intent classifier flags an interaction as
 * family_member_proxy or vendor_communication AND extracts a referenced
 * couple name (e.g. "Kajlie's mom" → referenced_couple_name = "Kajlie").
 *
 * Strategy:
 *   1. Query the venue's recent weddings (last 18 months, non-terminal-
 *      OR-still-imminent statuses).
 *   2. Fuzzy-match `referenced_couple_name` against each wedding's
 *      partner1.first_name / partner2.first_name (case-insensitive,
 *      bigram-Jaccard, threshold 0.55).
 *   3. When exactly one wedding clears the threshold, REATTACH the
 *      interaction to that wedding via the canonical mergeWeddings
 *      path (resolver.ts) — the orphan wedding row (if any) gets
 *      tombstoned, all FK children re-pointed.
 *   4. When zero or multiple match, log + leave the interaction where
 *      it is. Coordinator can re-link manually via the lead-detail
 *      panel.
 *
 * Never throws. Fire-and-forget. Audit row via logEvent.
 *
 * 2026-05-12 — checkpoint 6 of the Anja Putman / RM-1152 trace.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import { insertCandidateMatch } from '@/lib/services/identity/tracer'

const RECENT_WINDOW_MS = 18 * 30 * 86_400_000 // ~18 months

/**
 * 2026-09-14 ingestion audit item 4.
 *
 * `referenced_couple_name` is a field an LLM pulled out of an inbound
 * body, i.e. a string an outsider chose. At the old single threshold of
 * 0.55 bigram-Jaccard, that string could re-point an interaction's
 * `wedding_id` at another couple's wedding with no venue predicate on
 * the UPDATE and no human in the loop. "Kaj" scores 0.55 against
 * "Kajlie"; so does a fair amount of noise.
 *
 * Two thresholds now:
 *
 *   PROPOSE_THRESHOLD (0.70) — below this, nothing happens at all. The
 *     old 0.55 floor was producing the matches nobody wanted.
 *   AUTO_ATTACH_THRESHOLD (0.92) — at or above this the interaction is
 *     still re-pointed automatically, because a near-exact first-name
 *     match on a recent non-terminal wedding is the case this resolver
 *     was built for and a queue entry for it is noise.
 *
 * Between the two, the resolver writes a `candidate_matches` row and
 * stops. `/intel/identity-review` is the surface that adjudicates it —
 * the same queue `linkSignal` already feeds, so no new surface and no
 * second place for a coordinator to look.
 */
const PROPOSE_THRESHOLD = 0.7
const AUTO_ATTACH_THRESHOLD = 0.92

interface CandidateWedding {
  id: string
  partner1_first: string | null
  partner2_first: string | null
}

export interface ResolveArgs {
  supabase: SupabaseClient
  venueId: string
  interactionId: string
  referencedName: string
  intentClass: string
  correlationId?: string | null
}

/**
 * Bigram similarity (Jaccard over character bigram sets). 0..1.
 * Lowercase + alphanumeric strip first so 'Kajlie' matches 'Kajlie & Tom'
 * after splitting on the first token.
 */
function bigrams(s: string): Set<string> {
  const clean = s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) {
    out.add(clean.slice(i, i + 2))
  }
  return out
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

export async function resolveReferencedCouple(args: ResolveArgs): Promise<void> {
  const { supabase, venueId, interactionId, referencedName, intentClass, correlationId } = args

  // The classifier's extracted name can be "Kajlie", "Kajlie and Tom",
  // "Henderson". Take the first whitespace-separated token for the
  // partner1/partner2 first-name comparison; the bigram similarity
  // handles short tokens fine.
  const primaryToken = referencedName.trim().split(/\s+/)[0]
  if (!primaryToken) return

  const sinceIso = new Date(Date.now() - RECENT_WINDOW_MS).toISOString()

  // Pull candidate weddings + their partner first names.
  const { data: candidatesData, error } = await supabase
    .from('weddings')
    .select('id, status, inquiry_date, people!inner(role, first_name)')
    .eq('venue_id', venueId)
    .gte('inquiry_date', sinceIso)
    .not('status', 'in', '(lost,cancelled)')
    .is('merged_into_id', null)
    .limit(500)

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'referenced_couple candidates load failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.resolve_referenced',
      outcome: 'fail',
      data: { interactionId, error: error.message },
    })
    return
  }

  // Reshape into CandidateWedding rows. PostgREST embedded selects
  // return an array per row, so reduce manually.
  type Row = {
    id: string
    people: Array<{ role: string | null; first_name: string | null }> | null
  }
  const rows = (candidatesData ?? []) as Row[]
  const candidates: CandidateWedding[] = rows.map((r) => {
    const people = r.people ?? []
    const p1 = people.find((p) => p.role === 'partner1')
    const p2 = people.find((p) => p.role === 'partner2')
    return {
      id: r.id,
      partner1_first: p1?.first_name ?? null,
      partner2_first: p2?.first_name ?? null,
    }
  })

  // Score each candidate. Keep matches above threshold.
  const scored: Array<{ weddingId: string; score: number }> = []
  for (const c of candidates) {
    const s1 = c.partner1_first ? similarity(primaryToken, c.partner1_first) : 0
    const s2 = c.partner2_first ? similarity(primaryToken, c.partner2_first) : 0
    const best = Math.max(s1, s2)
    if (best >= PROPOSE_THRESHOLD) {
      scored.push({ weddingId: c.id, score: best })
    }
  }

  if (scored.length === 0) {
    logEvent({
      level: 'info',
      msg: 'referenced_couple no match',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.resolve_referenced',
      outcome: 'ok',
      data: { interactionId, referenced: referencedName, candidates: candidates.length },
    })
    return
  }

  // Multiple matches → ambiguous. Coordinator must decide. Don't auto-
  // merge in that case; surface the ambiguity in the audit log.
  scored.sort((a, b) => b.score - a.score)
  if (scored.length > 1 && scored[1].score >= PROPOSE_THRESHOLD * 0.95) {
    logEvent({
      level: 'warn',
      msg: 'referenced_couple ambiguous',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.resolve_referenced',
      outcome: 'skip',
      data: {
        ambiguous: true,
        interactionId,
        referenced: referencedName,
        top_matches: scored.slice(0, 3),
      },
    })
    return
  }

  const targetWeddingId: string = scored[0].weddingId

  // Load this interaction to find its current wedding_id. If it already
  // points at the target, no-op. If it points at a different wedding,
  // we need to reattach. We do NOT auto-merge the source wedding row —
  // mergeWeddings is destructive and lives behind the coordinator
  // review queue. For the Anja class we just re-point the interaction
  // so the conversation surfaces on Kajlie's lead-detail; if the
  // orphan wedding (RM-1152 in Anja's case) has no other meaningful
  // content, a future merge sweep handles it.
  const { data: currentRow } = await supabase
    .from('interactions')
    .select('wedding_id, person_id')
    .eq('id', interactionId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!currentRow) return
  if ((currentRow.wedding_id as string | null) === targetWeddingId) {
    return
  }

  // Audit item 4: between the propose floor and the auto-attach bar this
  // is a question, not an answer. Write it into the queue the coordinator
  // already reads and stop. Nothing is re-pointed.
  if (scored[0].score < AUTO_ATTACH_THRESHOLD) {
    await proposeReferencedCoupleMatch({
      supabase,
      venueId,
      interactionId,
      referencedName,
      intentClass,
      correlationId: correlationId ?? null,
      sourceWeddingId: (currentRow.wedding_id as string | null) ?? null,
      targetWeddingId,
      score: scored[0].score,
    })
    return
  }

  // Reattach the interaction. Person_id stays as-is — the sender (Anja)
  // is a different human than partner1/partner2; the wedding_relationships
  // table is the right home for her if/when the schema gets her there.
  // For now, just re-point the interaction so it surfaces on the right
  // wedding.
  //
  // The venue predicate is not decoration: without it a resolver running
  // on a stale or cross-tenant interaction id would re-point a row that
  // belongs to somebody else's venue. Service-role writes bypass RLS, so
  // the predicate IS the tenancy boundary here.
  const { error: updErr } = await supabase
    .from('interactions')
    .update({ wedding_id: targetWeddingId })
    .eq('id', interactionId)
    .eq('venue_id', venueId)

  if (updErr) {
    logEvent({
      level: 'warn',
      msg: 'referenced_couple reattach failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.resolve_referenced',
      outcome: 'fail',
      data: { interactionId, target: targetWeddingId, error: updErr.message },
    })
    return
  }

  logEvent({
    level: 'info',
    msg: 'referenced_couple reattached',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'inbound_intent.resolve_referenced',
    outcome: 'ok',
    data: {
      interactionId,
      referenced: referencedName,
      target_wedding_id: targetWeddingId,
      score: scored[0].score,
      intent_class: intentClass,
    },
  })
}

/**
 * Write a mid-confidence referenced-couple match into `candidate_matches`
 * so `/intel/identity-review` can adjudicate it.
 *
 * The queue's record types are couple / fragment / channel_scoped /
 * touchpoint (migrations 346 + 347) — there is no 'interaction' type, and
 * this workstream does not own migrations. So the proposal is expressed
 * in the vocabulary the queue already speaks: couple ↔ couple, resolved
 * through `couples.source_wedding_id`. The interaction id and the score
 * ride along in `matcher_reason`, which is the field the review surface
 * renders.
 *
 * When either side has no couple mirror there is nothing to enqueue. We
 * log and stop rather than inventing a row shape the surface cannot show;
 * a silent no-op that a coordinator never sees would be the worse outcome
 * of the two, so the log line is deliberately a warning.
 */
async function proposeReferencedCoupleMatch(args: {
  supabase: SupabaseClient
  venueId: string
  interactionId: string
  referencedName: string
  intentClass: string
  correlationId: string | null
  sourceWeddingId: string | null
  targetWeddingId: string
  score: number
}): Promise<void> {
  const {
    supabase, venueId, interactionId, referencedName, intentClass,
    correlationId, sourceWeddingId, targetWeddingId, score,
  } = args

  const coupleIdFor = async (weddingId: string | null): Promise<string | null> => {
    if (!weddingId) return null
    const { data } = await supabase
      .from('couples')
      .select('id')
      .eq('venue_id', venueId)
      .eq('source_wedding_id', weddingId)
      .is('merged_into_id', null)
      .maybeSingle()
    return (data?.id as string | null) ?? null
  }

  const [targetCoupleId, sourceCoupleId] = await Promise.all([
    coupleIdFor(targetWeddingId),
    coupleIdFor(sourceWeddingId),
  ])

  if (!targetCoupleId || !sourceCoupleId) {
    logEvent({
      level: 'warn',
      msg: 'referenced_couple proposal not queueable (missing couple mirror)',
      venueId,
      correlationId,
      actor: 'system',
      event_type: 'inbound_intent.resolve_referenced',
      outcome: 'skip',
      data: {
        interactionId,
        referenced: referencedName,
        target_wedding_id: targetWeddingId,
        source_wedding_id: sourceWeddingId,
        score,
        reason: 'no couples mirror for one or both weddings',
      },
    })
    return
  }

  if (targetCoupleId === sourceCoupleId) return

  await insertCandidateMatch(
    supabase,
    venueId,
    targetCoupleId,
    'couple',
    sourceCoupleId,
    'couple',
    // Mid-confidence by construction: anything at or above
    // AUTO_ATTACH_THRESHOLD never reaches this function.
    'medium',
    `referenced-couple resolver: inbound ${intentClass} named "${referencedName}" ` +
      `(bigram score ${score.toFixed(2)}). Interaction ${interactionId} currently sits on ` +
      `wedding ${sourceWeddingId ?? 'none'}; the named couple looks like wedding ${targetWeddingId}. ` +
      `Confirm to move the conversation.`,
  )

  logEvent({
    level: 'info',
    msg: 'referenced_couple proposed for review',
    venueId,
    correlationId,
    actor: 'system',
    event_type: 'inbound_intent.resolve_referenced',
    outcome: 'ok',
    data: {
      interactionId,
      referenced: referencedName,
      target_wedding_id: targetWeddingId,
      score,
      intent_class: intentClass,
      proposed: true,
    },
  })
}
