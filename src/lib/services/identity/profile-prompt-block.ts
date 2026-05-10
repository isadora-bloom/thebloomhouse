/**
 * Wave 4 Phase 3 — couple_identity_profile prompt-block formatter.
 *
 * Anchor docs:
 *   - bloom-constitution.md (the forensic record drives every Sage
 *     surface; this formatter is how brains read from the record)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 builds readers;
 *     Phase 4 retires duplicate writers — every "AI/Sage" brain that
 *     today re-extracts identity now reads from this block instead)
 *
 * Sensitivity policy
 * ------------------
 * Sensitive emotional truths (sensitive=true) are voice-shaping only.
 * The block emits a count + theme labels for sensitive truths so the
 * model knows there is emotional load to be careful about, but the
 * verbatim evidence_quote is NEVER included in the prompt — that
 * matches the universal-rules SOFT-CONTEXT NOTES POLICY for
 * coordinator-facing surfaces. External-facing surfaces (review
 * proposers, public replies) get an even tighter shape: sensitive
 * theme COUNT only, no labels.
 *
 * The block elides itself entirely (returns null) when the profile
 * has no readable content — empty headers waste tokens and can
 * mislead the model into thinking content was suppressed.
 */

import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

export type ProfileBlockSurface =
  | 'coordinator' // Email-reply brain, review-response brain, lead detail
  | 'external'    // Cultural-moments LLM proposer, public-facing proposers

export interface BuildProfileBlockOptions {
  /** Surface that will read this block. Coordinator surfaces see
   *  sensitive theme labels but never quotes; external surfaces see
   *  sensitive counts only (no labels, no quotes). */
  surface: ProfileBlockSurface
  /** Cap on family_dynamics entries to render. Tweak if a brain wants
   *  a tighter prompt budget. Defaults to 6. */
  maxFamilyDynamics?: number
  /** Cap on vendor_preferences. Defaults to 6. */
  maxVendorPreferences?: number
}

/**
 * Build a "## COUPLE PROFILE" block from a stored couple_identity_profile.
 * Returns null when the profile has no extractable content beyond names.
 */
export function buildCoupleProfileBlock(
  profile: CoupleIdentityProfile | null | undefined,
  options: BuildProfileBlockOptions,
): string | null {
  if (!profile) return null
  const { surface } = options
  const maxFam = options.maxFamilyDynamics ?? 6
  const maxVen = options.maxVendorPreferences ?? 6

  const lines: string[] = []

  // ---- Emotional truths (the load-bearing piece) ----------------
  const sensitive = profile.emotional_truths.filter((t) => t.sensitive)
  const nonSensitive = profile.emotional_truths.filter((t) => !t.sensitive)

  if (nonSensitive.length > 0 || sensitive.length > 0) {
    lines.push('### Emotional truths')
    if (nonSensitive.length > 0) {
      for (const t of nonSensitive) {
        // Coordinator + external both see non-sensitive theme labels
        // and the verbatim evidence_quote — these are not protected.
        lines.push(`- ${t.theme}: "${t.evidence_quote.slice(0, 200)}"`)
      }
    }
    if (sensitive.length > 0) {
      if (surface === 'coordinator') {
        // Theme labels yes, evidence_quote NO. Voice-shaping only.
        const labels = sensitive.map((t) => t.theme).join(', ')
        lines.push(
          `- SENSITIVE THEMES (${sensitive.length}, voice-shaping only — do NOT quote): ${labels}`,
        )
      } else {
        // External surface: count only.
        lines.push(
          `- SENSITIVE THEMES present (${sensitive.length}, voice-shaping only — do NOT quote and do NOT name)`,
        )
      }
    }
  }

  // ---- Occupations ----------------------------------------------
  if (profile.occupations.length > 0) {
    lines.push('### Occupations')
    for (const o of profile.occupations) {
      lines.push(`- ${o.partner_role}: ${o.occupation}`)
    }
  }

  // ---- Residence ------------------------------------------------
  if (profile.residence) {
    const where = [profile.residence.city, profile.residence.state]
      .filter((s) => s && s.trim())
      .join(', ')
    if (where) {
      lines.push(`### Residence`)
      lines.push(`- ${where}`)
    }
  }

  // ---- Family dynamics ------------------------------------------
  if (profile.family_dynamics.length > 0) {
    lines.push('### Family dynamics')
    for (const f of profile.family_dynamics.slice(0, maxFam)) {
      lines.push(`- ${f.relationship} (${f.signal})`)
    }
  }

  // ---- Vendor preferences ---------------------------------------
  if (profile.vendor_preferences.length > 0) {
    lines.push('### Vendor preferences')
    for (const v of profile.vendor_preferences.slice(0, maxVen)) {
      lines.push(`- ${v.vendor_type}: ${v.preference}`)
    }
  }

  // ---- Decision dynamics ----------------------------------------
  const dd = profile.decision_dynamics
  if (dd && (dd.who_decides || dd.who_questions || dd.who_negotiates)) {
    lines.push('### Decision dynamics')
    if (dd.who_decides) lines.push(`- decides: ${dd.who_decides}`)
    if (dd.who_questions) lines.push(`- questions: ${dd.who_questions}`)
    if (dd.who_negotiates) lines.push(`- negotiates: ${dd.who_negotiates}`)
  }

  // ---- Cultural signals (non-sensitive — fold for coord surfaces)
  if (profile.cultural_signals.length > 0 && surface === 'coordinator') {
    lines.push('### Cultural signals')
    for (const c of profile.cultural_signals.slice(0, 6)) {
      lines.push(`- ${c.signal}`)
    }
  }

  if (lines.length === 0) return null

  const header =
    surface === 'coordinator'
      ? `## COUPLE PROFILE
The reconstructed forensic record. Use this to ground the draft in
what the venue ACTUALLY knows about this couple. Sensitive themes
are voice-shaping only — never quote evidence verbatim, never echo
sensitive theme content directly back at the couple.`
      : `## COUPLE COHORT PROFILE
Forensic context aggregated for this venue's couples. Sensitive
themes count only — never name a couple, never echo sensitive
content. Use to weight the proposer's recommendations toward
themes that fit the cohort's actual emotional landscape.`

  return `${header}\n${lines.join('\n')}`
}

/**
 * Aggregate a list of profiles into a venue-level "## COUPLE COHORT
 * PROFILE" block for external proposers (cultural-moments,
 * marketing recommendation jobs). Sensitive themes report COUNT
 * ONLY — never named couples, never named themes.
 */
export function buildVenueCohortBlock(
  profiles: CoupleIdentityProfile[],
): string | null {
  if (profiles.length === 0) return null

  const themeCounts = new Map<string, number>()
  let sensitiveTotal = 0
  for (const p of profiles) {
    for (const t of p.emotional_truths) {
      if (t.sensitive) {
        sensitiveTotal += 1
        continue
      }
      const key = t.theme
      themeCounts.set(key, (themeCounts.get(key) ?? 0) + 1)
    }
  }
  const ranked = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)

  if (ranked.length === 0 && sensitiveTotal === 0) return null

  const lines: string[] = []
  lines.push('## COUPLE COHORT PROFILE')
  lines.push(
    `Aggregated emotional themes from this venue's recently reconstructed couple profiles. Counts only; no individual couple is named, no sensitive content is echoed.`,
  )
  lines.push(`- couples summarized: ${profiles.length}`)
  if (ranked.length > 0) {
    lines.push('### Top non-sensitive themes')
    for (const [theme, count] of ranked) {
      lines.push(`- ${theme}: ${count}`)
    }
  }
  if (sensitiveTotal > 0) {
    lines.push(
      `### Sensitive themes (count only, voice-shaping)\n- ${sensitiveTotal} sensitive theme observation${sensitiveTotal === 1 ? '' : 's'} across the cohort. Do NOT name themes. Do NOT quote evidence.`,
    )
  }
  return lines.join('\n')
}
