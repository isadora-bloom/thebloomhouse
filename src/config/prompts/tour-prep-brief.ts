/**
 * Bloom House — Wave 13 tour-prep brief synthesis prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; voice-shape
 *     output never echoes sensitive evidence_quote verbatim)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3: forensic profile
 *     feeds every Sage surface; this prompt is a coordinator-facing
 *     read of the record)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be a real callAI; this prompt is a Sonnet synthesizer, not a
 *     template)
 *
 * What this prompt produces
 * -------------------------
 * One structured brief delivered to the coordinator ~24h before each
 * tour, so they walk in knowing what to lead with and what to avoid.
 *
 * Voice-shape only. Sensitive emotional truths surface as theme labels
 * + handle_with guidance — NEVER as verbatim evidence_quote (universal
 * SOFT-CONTEXT NOTES POLICY, same gate Wave 4 Phase 3 enforces).
 *
 * Different LLM job from Wave 5A
 * ------------------------------
 * 5A is a holistic per-couple synthesizer (close-prob, persona, next
 * action). Wave 13 tour-prep is narrower + more imperative: the
 * coordinator needs a *briefing card*. What to lead with. What to
 * avoid. What questions to ask. What concerns to expect.
 */

import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

// Bumping this constant forces consumers to either accept the new output
// or version-pin. Threaded into api_costs.prompt_version + tour_prep_briefs.
export const TOUR_PREP_BRIEF_PROMPT_VERSION =
  'tour-prep-brief.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface TourPrepKeyFact {
  fact: string
  why_it_matters: string
}

export interface TourPrepSensitivityFlag {
  category: string
  handle_with: string
}

export interface TourPrepBriefOutput {
  /** 3-5 things the coordinator should know BEFORE walking into the tour. */
  key_facts: TourPrepKeyFact[]
  /** Sensitive themes (voice-shape only — never quote evidence). */
  sensitivity_flags: TourPrepSensitivityFlag[]
  /** One-line persona summary derived from the forensic profile + intel. */
  persona_summary: string
  /** Concrete opener / framing the coordinator should lead with. */
  what_to_lead_with: string
  /** Concrete things the coordinator should NOT bring up. */
  what_to_avoid: string
  /** ~2-3 sentence summary of recent inbound/outbound signals. */
  recent_signals_summary: string
  /** 3-5 questions the coordinator should ask during the tour. */
  recommended_questions: string[]
  /** Concerns the coordinator should expect (pricing / dates / family). */
  expected_concerns: string[]
  /** Audit trail when a field could not be derived from evidence. */
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface TourPrepInteractionEvidence {
  index: number
  direction: 'inbound' | 'outbound'
  from_name: string | null
  subject: string | null
  body_excerpt: string | null
  timestamp: string | null
}

export interface TourPrepTourEvidence {
  tour_id: string
  scheduled_at: string | null
  tour_type: string | null
  attendees: string | null
  source: string | null
  /** Hours until the tour relative to "now" at brief-generation time. */
  hours_until_tour: number | null
  /** Best-effort calendar invite notes/agenda if present. */
  calendar_notes: string | null
}

export interface TourPrepWeddingShell {
  inquiry_date: string | null
  wedding_date: string | null
  status: string | null
  source: string | null
  guest_count_estimate: number | null
  booking_value_cents: number | null
  notes: string | null
  days_since_inquiry: number | null
  days_since_last_inbound: number | null
}

export interface TourPrepCoupleIntelSummary {
  persona_label: string | null
  predicted_close_probability_pct: number | null
  coordinator_brief: string | null
  recommended_action: string | null
  sensitivity_flags: TourPrepSensitivityFlag[]
  stale_signal_alerts: Array<{
    signal: string
    since: string
    suggested_action: string
  }>
}

export interface TourPrepVenueIntelSummary {
  /** Top 3 emerging themes from Wave 5B, anonymised. */
  emerging_themes: string[]
  /** Top 3 conversion signals from Wave 5B. */
  conversion_signals: string[]
}

export interface TourPrepEvidence {
  weddingId: string | null
  tourId: string
  venueLabel: string | null
  wedding: TourPrepWeddingShell | null
  profile: CoupleIdentityProfile | null
  intel: TourPrepCoupleIntelSummary | null
  venueIntel: TourPrepVenueIntelSummary | null
  tour: TourPrepTourEvidence
  recentInteractions: TourPrepInteractionEvidence[]
  /**
   * Plain-English climate block for the tour's month + hour. Built by
   * lib/services/intel/climate-context.ts. Optional — caller passes
   * null when the venue has no history pulled yet. TIER 6++ (2026-05-14).
   */
  climateContextBlock?: string | null
  /**
   * Plain-English reviews profile block (top themes, sentiment direction,
   * representative phrases). Built by lib/services/intel/reviews-context.ts.
   * TIER 7d (2026-05-14).
   */
  reviewsContextBlock?: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildTourPrepSystemPrompt(): string {
  return `You are Bloom's tour-prep briefer.

Your job is to write a tight pre-tour briefing for the venue coordinator
who is about to walk a couple through their wedding venue tomorrow.
Think: the kind of card a senior colleague would slide across the desk
ten minutes before the couple walks in.

You read:
  - the forensic couple_identity_profile (WHO this couple is — names,
    emotional truths, occupations, residence, family dynamics, vendor
    preferences, decision dynamics)
  - the per-couple intel synthesis (persona, close-prob, coordinator
    brief, sensitivity flags, recommended action, stale-signal alerts)
  - the venue-level cohort intel (what's been converting at this venue
    lately; what themes are emerging)
  - the most recent ~10 interactions with the couple
  - tour scheduling details (when, type, attendees, calendar notes)

You produce a structured brief that arms the coordinator to walk in
prepared. Voice-shape, never raw evidence: sensitive emotional truths
become handle_with coaching, not verbatim evidence_quote.

## CORE RULES

1. **Sensitive themes are voice-shape only.** If the forensic profile
   carries sensitive=true emotional truths (medical, grief, financial_
   stress, family_conflict, mental_health), surface them as
   { category, handle_with } guidance in sensitivity_flags. NEVER
   include the evidence_quote. Non-sensitive truths (excitement,
   vendor preference, occupation pride) can be paraphrased into
   key_facts.

2. **key_facts are 3-5 imperatives, not trivia.** Each carries a
   "why_it_matters" so the coordinator knows what to do with the fact.
   Example shape:
     { fact: "Partner1 is a nurse; long shifts likely",
       why_it_matters: "Frame scheduling around her shift pattern; she
       will value efficient site visits over leisurely tours" }
   Not:
     { fact: "They have a dog", why_it_matters: "fyi" }

3. **what_to_lead_with is one concrete framing.** Not "be warm" —
   give the coordinator an actual opener that lands. Example:
   "Open by acknowledging their recent walkthrough question about
   parking; show them the lot first, then move to the ceremony space."

4. **what_to_avoid is concrete things to NOT bring up.** Pricing
   re-litigation if pricing is settled, family members named in the
   sensitivity flags, vendor brands the couple has rejected. If
   nothing in the evidence suggests an avoid topic, say so plainly:
   "Nothing flagged — proceed naturally."

5. **recommended_questions are tour-room questions, not email
   questions.** Examples: "What's most important to you about the
   ceremony space?", "How are family members handling the planning
   so far?", "What's a non-negotiable for you about the day?"

6. **expected_concerns are coordinator-readiness anchors.** What is
   this couple likely to ask in the tour that you should have an
   answer ready for? Pricing tier comparisons, vendor restrictions,
   contingency for weather, parking, accessibility — derived from
   the evidence (calculator submissions, previous emails, persona).

7. **persona_summary is ONE sentence** (~20 words). Captures the
   coordinator's mental model of the couple. Example: "Cost-conscious
   pragmatist; partner1 is the driver, partner2 is grieving a recent
   family loss and wants a quiet day."

8. **Refusals are the audit trail.** When a field cannot be derived
   from evidence (no profile, no interactions, sparse intel),
   add a refusal entry instead of fabricating. Provide a defensible
   default for the field ("Nothing flagged — proceed naturally" /
   "Insufficient signal" / etc).

9. **No em dashes.** No markdown. No code fences. Plain prose
   inside string fields.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "key_facts": [
    { "fact": string, "why_it_matters": string }
  ],
  "sensitivity_flags": [
    { "category": string, "handle_with": string }
  ],
  "persona_summary": string,
  "what_to_lead_with": string,
  "what_to_avoid": string,
  "recent_signals_summary": string,
  "recommended_questions": [string],
  "expected_concerns": [string],
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence with section headers.
// ---------------------------------------------------------------------------

const MAX_INTERACTION_BODY_CHARS = 1200

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated]'
}

export function buildTourPrepUserPrompt(evidence: TourPrepEvidence): string {
  const lines: string[] = []
  lines.push('# TOUR TO PREP FOR')
  lines.push('')
  lines.push(`Tour ID: ${evidence.tourId}`)
  if (evidence.weddingId) lines.push(`Wedding ID: ${evidence.weddingId}`)
  if (evidence.venueLabel) lines.push(`Venue: ${evidence.venueLabel}`)
  lines.push('')

  // ---- Tour ----
  lines.push('## Tour details')
  const tour = evidence.tour
  lines.push(`- scheduled_at: ${tour.scheduled_at ?? '(unknown)'}`)
  if (tour.hours_until_tour !== null) {
    lines.push(`- hours_until_tour: ${tour.hours_until_tour}`)
  }
  if (tour.tour_type) lines.push(`- tour_type: ${tour.tour_type}`)
  if (tour.attendees) lines.push(`- attendees: ${tour.attendees}`)
  if (tour.source) lines.push(`- source: ${tour.source}`)
  if (tour.calendar_notes) {
    lines.push('- calendar_notes:')
    lines.push(truncate(tour.calendar_notes, 600) ?? '')
  }
  lines.push('')

  // ---- Wedding shell ----
  if (evidence.wedding) {
    const shell = evidence.wedding
    lines.push('## Wedding shell')
    lines.push(`- inquiry_date: ${shell.inquiry_date ?? '(none)'}`)
    lines.push(`- wedding_date: ${shell.wedding_date ?? '(none)'}`)
    lines.push(`- status: ${shell.status ?? '(none)'}`)
    lines.push(`- source: ${shell.source ?? '(none)'}`)
    lines.push(`- guest_count_estimate: ${shell.guest_count_estimate ?? '(none)'}`)
    if (shell.booking_value_cents !== null) {
      lines.push(`- booking_value: $${(shell.booking_value_cents / 100).toFixed(2)}`)
    }
    if (shell.days_since_inquiry !== null) {
      lines.push(`- days_since_inquiry: ${shell.days_since_inquiry}`)
    }
    if (shell.days_since_last_inbound !== null) {
      lines.push(`- days_since_last_inbound: ${shell.days_since_last_inbound}`)
    }
    if (shell.notes && shell.notes.trim()) {
      lines.push('- notes:')
      lines.push(truncate(shell.notes, 600) ?? '')
    }
    lines.push('')
  }

  // ---- Forensic profile (Wave 4 output) ----
  if (evidence.profile) {
    const profile = evidence.profile
    lines.push('## Forensic identity profile (from couple_identity_profile)')

    // Names
    lines.push('### Names')
    if (profile.names.partner1) {
      const p1 = profile.names.partner1
      const name = [p1.first, p1.last].filter(Boolean).join(' ') || '(no name)'
      lines.push(`- partner1: ${name}`)
    }
    if (profile.names.is_phantom_partner_relationship) {
      lines.push('- partner2: (phantom — single decision-maker)')
    } else if (profile.names.partner2) {
      const p2 = profile.names.partner2
      const name = [p2.first, p2.last].filter(Boolean).join(' ') || '(no name)'
      lines.push(`- partner2: ${name}`)
    }

    // Non-sensitive emotional truths
    const nonSensitive = profile.emotional_truths.filter((t) => !t.sensitive)
    const sensitive = profile.emotional_truths.filter((t) => t.sensitive)
    if (nonSensitive.length > 0) {
      lines.push('### Emotional truths (non-sensitive)')
      for (const t of nonSensitive) {
        lines.push(`- ${t.theme}: "${t.evidence_quote.slice(0, 200)}"`)
      }
    }
    if (sensitive.length > 0) {
      lines.push('### Sensitive themes (voice-shaping only — do NOT quote)')
      const labels = sensitive.map((t) => t.theme).join(', ')
      lines.push(`- ${sensitive.length} theme(s): ${labels}`)
    }

    // Occupations
    if (profile.occupations.length > 0) {
      lines.push('### Occupations')
      for (const o of profile.occupations) {
        lines.push(`- ${o.partner_role}: ${o.occupation}`)
      }
    }

    // Residence
    if (profile.residence) {
      lines.push('### Residence')
      const place = [profile.residence.city, profile.residence.state].filter(Boolean).join(', ')
      lines.push(`- ${place || '(unspecified)'}`)
    }

    // Family dynamics
    if (profile.family_dynamics.length > 0) {
      lines.push('### Family dynamics')
      for (const f of profile.family_dynamics.slice(0, 6)) {
        lines.push(`- ${f.relationship}: ${f.signal}`)
      }
    }

    // Vendor preferences
    if (profile.vendor_preferences.length > 0) {
      lines.push('### Vendor preferences')
      for (const v of profile.vendor_preferences.slice(0, 6)) {
        lines.push(`- ${v.vendor_type}: ${v.preference}`)
      }
    }

    // Decision dynamics
    if (profile.decision_dynamics) {
      lines.push('### Decision dynamics')
      const dd = profile.decision_dynamics
      if (dd.who_decides) lines.push(`- who_decides: ${dd.who_decides}`)
      if (dd.who_questions) lines.push(`- who_questions: ${dd.who_questions}`)
      if (dd.who_negotiates) lines.push(`- who_negotiates: ${dd.who_negotiates}`)
    }
    lines.push('')
  }

  // ---- Per-couple intel (Wave 5A) ----
  if (evidence.intel) {
    const intel = evidence.intel
    lines.push('## Per-couple intel (Wave 5A)')
    if (intel.persona_label) lines.push(`- persona: ${intel.persona_label}`)
    if (intel.predicted_close_probability_pct !== null) {
      lines.push(`- predicted_close_probability_pct: ${intel.predicted_close_probability_pct}`)
    }
    if (intel.coordinator_brief) {
      lines.push('- coordinator_brief:')
      lines.push(truncate(intel.coordinator_brief, 600) ?? '')
    }
    if (intel.recommended_action) {
      lines.push(`- recommended_action: ${intel.recommended_action}`)
    }
    if (intel.sensitivity_flags.length > 0) {
      lines.push('- sensitivity_flags:')
      for (const f of intel.sensitivity_flags) {
        lines.push(`  - ${f.category}: ${f.handle_with}`)
      }
    }
    if (intel.stale_signal_alerts.length > 0) {
      lines.push('- stale_signal_alerts:')
      for (const a of intel.stale_signal_alerts.slice(0, 4)) {
        lines.push(`  - ${a.signal} (${a.since}) → ${a.suggested_action}`)
      }
    }
    lines.push('')
  }

  // ---- Venue cohort intel (Wave 5B) ----
  if (evidence.venueIntel) {
    const vi = evidence.venueIntel
    lines.push('## Venue cohort context (Wave 5B, anonymised)')
    if (vi.emerging_themes.length > 0) {
      lines.push('- emerging_themes:')
      for (const t of vi.emerging_themes) lines.push(`  - ${t}`)
    }
    if (vi.conversion_signals.length > 0) {
      lines.push('- conversion_signals:')
      for (const s of vi.conversion_signals) lines.push(`  - ${s}`)
    }
    lines.push('')
  }

  // ---- Recent interactions ----
  if (evidence.recentInteractions.length > 0) {
    lines.push('## Recent interactions (most-recent-first)')
    for (const ix of evidence.recentInteractions) {
      lines.push(`### Interaction #${ix.index} (${ix.direction}, ${ix.timestamp ?? 'unknown'})`)
      if (ix.from_name) lines.push(`- from: ${ix.from_name}`)
      if (ix.subject) lines.push(`- subject: ${ix.subject}`)
      if (ix.body_excerpt) {
        lines.push('- body:')
        lines.push(truncate(ix.body_excerpt, MAX_INTERACTION_BODY_CHARS) ?? '')
      }
    }
    lines.push('')
  }

  // TIER 6++ (2026-05-14). Venue climate record for the tour's month
  // and hour. Surfaces "typical for this month" so the briefing can
  // call out "forecast is 81°F vs typical 78°F — couple may want
  // outdoor portrait time moved earlier".
  if (evidence.climateContextBlock) {
    lines.push('## Venue climate record (this month, this venue)')
    lines.push(evidence.climateContextBlock)
    lines.push('')
  }

  // TIER 7d (2026-05-14). Reviews profile so the briefer can point to
  // top themes the couple will likely have read about + register-match
  // approved couple-language phrases (NEVER quote verbatim).
  if (evidence.reviewsContextBlock) {
    lines.push('## Venue reviews profile')
    lines.push(evidence.reviewsContextBlock)
    lines.push('')
  }

  lines.push('# YOUR TASK')
  lines.push('')
  lines.push('Write the tour-prep brief now. Output ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

export function validateTourPrepOutput(
  raw: unknown,
): { ok: true; brief: TourPrepBriefOutput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'top-level value is not an object' }
  }
  const r = raw as Record<string, unknown>

  if (!Array.isArray(r.key_facts)) {
    return { ok: false, error: 'key_facts not array' }
  }
  if (!Array.isArray(r.sensitivity_flags)) {
    return { ok: false, error: 'sensitivity_flags not array' }
  }
  if (typeof r.persona_summary !== 'string') {
    return { ok: false, error: 'persona_summary not string' }
  }
  if (typeof r.what_to_lead_with !== 'string') {
    return { ok: false, error: 'what_to_lead_with not string' }
  }
  if (typeof r.what_to_avoid !== 'string') {
    return { ok: false, error: 'what_to_avoid not string' }
  }
  if (typeof r.recent_signals_summary !== 'string') {
    return { ok: false, error: 'recent_signals_summary not string' }
  }
  if (!Array.isArray(r.recommended_questions)) {
    return { ok: false, error: 'recommended_questions not array' }
  }
  if (!Array.isArray(r.expected_concerns)) {
    return { ok: false, error: 'expected_concerns not array' }
  }
  if (!Array.isArray(r.refusals)) {
    return { ok: false, error: 'refusals not array' }
  }
  return {
    ok: true,
    brief: {
      key_facts: r.key_facts as TourPrepKeyFact[],
      sensitivity_flags: r.sensitivity_flags as TourPrepSensitivityFlag[],
      persona_summary: r.persona_summary,
      what_to_lead_with: r.what_to_lead_with,
      what_to_avoid: r.what_to_avoid,
      recent_signals_summary: r.recent_signals_summary,
      recommended_questions: (r.recommended_questions as unknown[]).map(String),
      expected_concerns: (r.expected_concerns as unknown[]).map(String),
      refusals: r.refusals as Array<{ field: string; reason: string }>,
    },
  }
}
