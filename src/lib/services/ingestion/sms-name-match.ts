/**
 * Bloom House — SMS name-extraction + match service.
 *
 * Called by the OpenPhone sync (and by a backfill admin route) when an
 * inbound SMS arrives from a phone not yet in `contacts`. Pulls a name
 * out of the body via Haiku, then queries `people` for a single
 * confident match scoped to the venue + last 6 months of activity.
 *
 * Returns:
 *   - { personId, weddingId, confidence } when a single confident match exists
 *   - null when no name was extracted, no match was found, or the result
 *     was ambiguous (multiple weddings with the same first name)
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — auto-link only on
 *     unambiguous matches; everything else is unmatched and surfaces for
 *     review)
 *   - feedback_deep_fix_vs_bandaid.md Pattern 1
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, type ContentTier } from '@/lib/ai/client'
import {
  SMS_IDENTIFY_PROMPT_VERSION,
  buildSmsIdentifySystemPrompt,
  buildSmsIdentifyUserPrompt,
  validateSmsIdentifyOutput,
} from '@/config/prompts/sms-identify-person'

// Pulls every email-shaped token out of a body. Same shape used by
// body-extract.ts; duplicated here so this service doesn't reach into
// the email-pipeline private helper.
const BODY_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

function findBodyEmails(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  let m: RegExpExecArray | null
  // Reset lastIndex each call (BODY_EMAIL_RE is /g).
  BODY_EMAIL_RE.lastIndex = 0
  while ((m = BODY_EMAIL_RE.exec(text))) out.add(m[0].toLowerCase())
  return [...out]
}

interface BodyEmailMatchInput {
  supabase: SupabaseClient
  venueId: string
  body: string
  correlationId?: string
}

/**
 * Scan the body for an email address and resolve to a person+wedding
 * via the canonical identity resolver. When the resolver returns an
 * existing match, we use it. When it would create a fresh person+
 * wedding (no existing match for that email), we run the joint-handle
 * parser to seed names + still create the fresh row — the operator
 * gets a real Justin + Sandy record instead of a no-name placeholder.
 */
async function tryMatchByBodyEmail(
  input: BodyEmailMatchInput,
): Promise<MatchByNameResult | null> {
  const { supabase, venueId, body, correlationId } = input
  const emails = findBodyEmails(body)
  if (emails.length === 0) return null

  // Lazy import the resolver + joint-handle parser so module load is cheap.
  const [{ resolveIdentity }, { parseJointEmailHandle, inferNameFromEmail }] =
    await Promise.all([
      import('@/lib/services/identity/resolver'),
      import('@/lib/services/identity/name-capture'),
    ])

  for (const email of emails) {
    // Joint-handle parse first (justinlovewithsandy → {Justin, Sandy}).
    // Falls back to inferNameFromEmail (first.last) for single-person
    // handles. Both yield first-name hints that resolveIdentity uses
    // when minting fresh rows.
    const joint = parseJointEmailHandle(email)
    const single = joint ? null : inferNameFromEmail(email)

    const partner1Name = joint?.partner1_first ?? single?.first ?? null
    const partner2Name = joint?.partner2_first ?? null
    const fullName = single
      ? [single.first, single.last].filter(Boolean).join(' ') || null
      : null

    try {
      const resolved = await resolveIdentity(
        venueId,
        {
          email,
          phone: null,
          fullName,
          weddingDate: null,
          partner1Name,
          partner2Name,
        },
        {
          sourceLabel: 'sms_body_email',
          supabase,
          correlationId,
        },
      )

      // Fire the identity-discovery cascade in the background. Whether
      // the resolver attached us to an existing wedding or minted a
      // fresh one, the new email + first names are fresh fingerprints
      // that backtrack + candidate-resolver can use to bind anonymous
      // Knot / IG / Pinterest / WeddingWire storefront signals to this
      // wedding. Fire-and-forget — never block the SMS persist on it.
      if (resolved.weddingId) {
        const weddingId = resolved.weddingId
        void (async () => {
          try {
            const { triggerIdentityCascade } = await import(
              '@/lib/services/identity/cascade-on-enrichment'
            )
            await triggerIdentityCascade({
              venueId,
              weddingId,
              supabase,
              reason: `sms_body_email_${resolved.matchedBy}`,
              correlationId: correlationId ?? null,
            })
          } catch (err) {
            console.warn(
              '[sms-name-match] cascade fire-and-forget threw:',
              err instanceof Error ? err.message : err,
            )
          }
        })()
      }

      return {
        personId: resolved.personId,
        weddingId: resolved.weddingId,
        matchedName: partner1Name
          ? partner2Name
            ? `${partner1Name} & ${partner2Name}`
            : partner1Name
          : email,
        confidence: resolved.matchedBy === 'created_new' ? 80 : 95,
        evidence: `body email: ${email}${joint ? ` (joint handle → ${partner1Name} & ${partner2Name})` : ''}`,
      }
    } catch (err) {
      console.warn('[sms-name-match] body-email resolve failed (non-fatal):', err)
      // Try the next email in the body.
    }
  }

  return null
}

const LOOKBACK_MS = 1000 * 60 * 60 * 24 * 180 // 180 days

const CONFIDENT_THRESHOLD = 70

export interface MatchByNameInput {
  supabase: SupabaseClient
  venueId: string
  body: string
  fromPhone: string | null
  correlationId?: string
}

export interface MatchByNameResult {
  personId: string
  weddingId: string | null
  matchedName: string
  confidence: number
  evidence: string
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

// Cheap pre-filter: skip extremely short replies that almost certainly
// carry no signal ("ok", "thanks", "yes"). Anything longer goes to Haiku
// so we catch both name self-id AND event-context clues ("running late
// for my tour", "moving our Saturday wedding").
function worthClassifying(body: string): boolean {
  if (!body) return false
  const trimmed = body.trim()
  if (trimmed.length < 8) return false
  // One-word acks aren't worth a Haiku call.
  if (/^(?:ok|okay|yes|no|sure|thanks|thx|👍|👌|received)[!.?\s]*$/i.test(trimmed)) {
    return false
  }
  return true
}

export async function tryMatchSmsByName(
  input: MatchByNameInput,
): Promise<MatchByNameResult | null> {
  const { supabase, venueId, body, fromPhone, correlationId } = input
  if (!body || body.length < 4) return null

  // ----- Tier 0: body-mentioned email address -----
  // 2026-05-12: couples often share a joint email in a text ("can you
  // email us at justinlovewithsandy@gmail.com"). The email is the most
  // reliable cross-channel identifier — emails outlast phone changes
  // and joint-handle parsing extracts both partner names at once. Try
  // this BEFORE the LLM call because:
  //   - It's deterministic + free (regex + DB lookup, no Anthropic cost)
  //   - It catches the case the LLM can't (a couple texting their email
  //     address rarely also self-introduces in the same message)
  //   - The resolver match by email is the strongest signal in the
  //     identity chain (see resolver.ts match-chain ordering)
  const bodyEmailMatch = await tryMatchByBodyEmail({
    supabase,
    venueId,
    body,
    correlationId,
  })
  if (bodyEmailMatch) return bodyEmailMatch

  if (!worthClassifying(body)) return null

  // Haiku name + event-context extraction.
  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt: buildSmsIdentifySystemPrompt(),
      userPrompt: buildSmsIdentifyUserPrompt({ body, fromPhone }),
      maxTokens: 200,
      temperature: 0.1,
      venueId,
      taskType: 'sms_identify_person',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: SMS_IDENTIFY_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    console.warn('[sms-name-match] ai call failed:', err)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(aiResult.text))
  } catch {
    return null
  }
  const validation = validateSmsIdentifyOutput(parsed)
  if (!validation.ok) return null

  const { first_name, last_name, confidence_0_100, evidence, event } = validation.output

  // ----- Tier 1: name-based match (strongest signal) -----
  if (first_name && confidence_0_100 >= CONFIDENT_THRESHOLD) {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    let query = supabase
      .from('people')
      .select(
        'id, first_name, last_name, wedding_id, weddings!inner ( id, status, inquiry_date, updated_at )',
      )
      .eq('venue_id', venueId)
      .ilike('first_name', first_name)
      .in('role', ['partner1', 'partner2'])
      .not('weddings.status', 'in', '(lost,cancelled,completed)')
      .gte('weddings.updated_at', since)
      .limit(10)
    if (last_name) {
      query = query.ilike('last_name', last_name)
    }
    const { data: candidates } = await query

    type Candidate = {
      id: string
      first_name: string | null
      last_name: string | null
      wedding_id: string | null
      weddings:
        | { id: string; status: string | null; inquiry_date: string | null; updated_at: string | null }
        | { id: string; status: string | null; inquiry_date: string | null; updated_at: string | null }[]
        | null
    }
    const rows = (candidates as Candidate[] | null) ?? []

    if (rows.length === 1) {
      const row = rows[0]
      return {
        personId: row.id,
        weddingId: row.wedding_id,
        matchedName: [row.first_name, row.last_name].filter(Boolean).join(' ') || first_name,
        confidence: confidence_0_100,
        evidence,
      }
    }

    if (rows.length > 1 && last_name) {
      const consistent = rows.every(
        (r) => (r.last_name ?? '').toLowerCase() === last_name.toLowerCase(),
      )
      if (consistent) {
        const sorted = [...rows].sort((a, b) => {
          const aw = Array.isArray(a.weddings) ? a.weddings[0] : a.weddings
          const bw = Array.isArray(b.weddings) ? b.weddings[0] : b.weddings
          return (aw?.updated_at ?? '') < (bw?.updated_at ?? '') ? 1 : -1
        })
        const top = sorted[0]
        return {
          personId: top.id,
          weddingId: top.wedding_id,
          matchedName:
            [top.first_name, top.last_name].filter(Boolean).join(' ') || first_name,
          confidence: confidence_0_100,
          evidence,
        }
      }
    }
    // First-name only with multiple candidates → fall through to event
    // matching. If event picks one wedding, we'll cross-validate by name.
  }

  // ----- Tier 2: event-context match (no name, or ambiguous name) -----
  // Common case: "running late for my tour" with no name. If a tour is
  // scheduled near now (or near tour_time_local), the body is almost
  // certainly from that couple.
  if (event.references_tour) {
    const now = new Date()

    // Build the candidate scheduled-at window.
    // If tour_time_local is present, narrow to today within ±90 min.
    // Otherwise, take ANY tour with scheduled_at in [-2h, +6h] from now,
    // which covers "I'm 10 minutes away" + "we're still 30 min out".
    let windowStart: Date
    let windowEnd: Date
    if (event.tour_time_local) {
      const [hh, mm] = event.tour_time_local.split(':').map((n) => parseInt(n, 10))
      const target = new Date(now)
      target.setHours(hh, mm, 0, 0)
      windowStart = new Date(target.getTime() - 90 * 60_000)
      windowEnd = new Date(target.getTime() + 90 * 60_000)
    } else {
      windowStart = new Date(now.getTime() - 2 * 60 * 60_000)
      windowEnd = new Date(now.getTime() + 6 * 60 * 60_000)
    }

    const { data: tourCandidates } = await supabase
      .from('tours')
      .select('id, wedding_id, scheduled_at, outcome')
      .eq('venue_id', venueId)
      .gte('scheduled_at', windowStart.toISOString())
      .lte('scheduled_at', windowEnd.toISOString())
      .in('outcome', ['pending', 'completed'])
      .order('scheduled_at', { ascending: true })

    type TourRow = {
      id: string
      wedding_id: string | null
      scheduled_at: string | null
      outcome: string | null
    }
    const tours = (tourCandidates as TourRow[] | null) ?? []
    const withWedding = tours.filter((t) => t.wedding_id)

    if (withWedding.length === 1) {
      const t = withWedding[0]
      // Look up the partner1 person to attach the SMS for display.
      const { data: person } = await supabase
        .from('people')
        .select('id, first_name, last_name')
        .eq('venue_id', venueId)
        .eq('wedding_id', t.wedding_id)
        .in('role', ['partner1'])
        .limit(1)
        .maybeSingle()
      const p = person as { id: string; first_name: string | null; last_name: string | null } | null
      if (p) {
        return {
          personId: p.id,
          weddingId: t.wedding_id,
          matchedName:
            [p.first_name, p.last_name].filter(Boolean).join(' ') || 'tour-window match',
          confidence: 75,
          evidence: `${evidence || 'event-context match'} · tour at ${new Date(t.scheduled_at ?? now).toLocaleString()}`,
        }
      }
    }
    // 0 or 2+ tours in the window → ambiguous, fall through.
  }

  // No confident match. Operator decides.
  return null
}
