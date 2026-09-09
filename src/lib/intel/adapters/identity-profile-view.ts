/**
 * Identity-profile view — reading the Wave-4 forensic profile jsonb.
 *
 * Two bugs are fixed by this file existing.
 *
 * 1. /intel/couples/[id] queried `couple_identity_profile` by
 *    `couple_id`. That table is keyed by `wedding_id` (migration 260),
 *    so PostgREST answered 400 and the card silently never rendered.
 *    `getCoupleJourney` does the correct lookup, via
 *    `couples.source_wedding_id`.
 *
 * 2. The page's local type declared flat columns
 *    (`primary_first_name`, `emotional_themes`, ...). The row holds a
 *    single `profile` jsonb shaped like `CoupleIdentityProfile` — nested
 *    name claims, each with a confidence and a verbatim evidence quote.
 *    Even had the query worked, every field would have read undefined.
 *
 * So the profile is parsed here, defensively, from the jsonb the
 * canonical reader returns. Nothing is invented: a claim with no
 * evidence quote renders without one, and a missing block renders as
 * absent rather than blank.
 *
 * Pure. Unit-tested in ./__tests__/identity-profile-view.test.ts.
 */

export interface ProfileNameView {
  name: string
  occupation: string | null
  confidence: number | null
  evidenceQuote: string | null
}

export interface ProfileClaimView {
  /** Short label, e.g. a theme or a relationship. */
  label: string
  /** Optional detail beneath the label. */
  detail: string | null
  evidenceQuote: string | null
  /** Sensitive claims are rendered behind a disclosure, never inline. */
  sensitive: boolean
}

export interface IdentityProfileView {
  /** True when there is at least one populated claim worth rendering. */
  hasContent: boolean
  partner1: ProfileNameView | null
  partner2: ProfileNameView | null
  /** 'high' | 'medium' | 'low' | 'unknown' — the model's own read on the
   *  name evidence. Rendered so the operator knows how firm a name is. */
  nameQuality: string | null
  /** The model flagged a partner who is referenced but never named. */
  phantomPartner: boolean
  residence: string | null
  residenceQuote: string | null
  emotionalTruths: ProfileClaimView[]
  familyDynamics: ProfileClaimView[]
  culturalSignals: ProfileClaimView[]
  accessibilityNeeds: ProfileClaimView[]
  handles: ProfileClaimView[]
  /** Fields the model explicitly refused to guess at, with its reason.
   *  Surfacing refusals is the point: a refusal is information. */
  refusals: Array<{ field: string; reason: string }>
}

// — defensive readers ————————————————————————————————————————————————

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function nameView(
  claim: unknown,
  occupations: unknown[],
  role: 'partner1' | 'partner2',
): ProfileNameView | null {
  const c = obj(claim)
  if (!c) return null
  const first = str(c.first)
  const last = str(c.last)
  const name = [first, last].filter(Boolean).join(' ')
  if (!name) return null

  let occupation: string | null = null
  for (const o of occupations) {
    const oc = obj(o)
    if (!oc) continue
    if (str(oc.partner_role) === role) {
      occupation = str(oc.occupation)
      if (occupation) break
    }
  }

  return {
    name,
    occupation,
    confidence: num(c.confidence_0_100),
    evidenceQuote: str(c.evidence_quote),
  }
}

function claimList(
  raw: unknown,
  labelKey: string,
  detailKey: string | null,
): ProfileClaimView[] {
  const out: ProfileClaimView[] = []
  for (const item of arr(raw)) {
    const c = obj(item)
    if (!c) continue
    const label = str(c[labelKey])
    if (!label) continue
    out.push({
      label,
      detail: detailKey ? str(c[detailKey]) : null,
      evidenceQuote: str(c.evidence_quote),
      sensitive: c.sensitive === true,
    })
  }
  return out
}

/**
 * Parse the `profile` jsonb that `getCoupleJourney` returns as
 * `identityProfile` into something a card can render. Returns a view
 * with `hasContent: false` when the profile is missing or empty, so the
 * caller renders an EmptyState rather than a card full of blanks.
 */
export function buildIdentityProfileView(
  profile: Record<string, unknown> | null,
): IdentityProfileView {
  const empty: IdentityProfileView = {
    hasContent: false,
    partner1: null,
    partner2: null,
    nameQuality: null,
    phantomPartner: false,
    residence: null,
    residenceQuote: null,
    emotionalTruths: [],
    familyDynamics: [],
    culturalSignals: [],
    accessibilityNeeds: [],
    handles: [],
    refusals: [],
  }
  if (!profile) return empty

  const names = obj(profile.names)
  const occupations = arr(profile.occupations)
  const partner1 = nameView(names?.partner1, occupations, 'partner1')
  const partner2 = nameView(names?.partner2, occupations, 'partner2')

  const residenceRaw = obj(profile.residence)
  const residence = residenceRaw
    ? [str(residenceRaw.city), str(residenceRaw.state)].filter(Boolean).join(', ') || null
    : null

  const emotionalTruths = claimList(profile.emotional_truths, 'theme', null)
  const familyDynamics = claimList(profile.family_dynamics, 'relationship', 'signal')
  const culturalSignals = claimList(profile.cultural_signals, 'signal', null)
  const accessibilityNeeds = claimList(profile.accessibility_needs, 'need', null)
  const handles = claimList(profile.handles, 'platform', 'handle')

  const refusals: Array<{ field: string; reason: string }> = []
  for (const r of arr(profile.refusals)) {
    const c = obj(r)
    const field = c ? str(c.field) : null
    const reason = c ? str(c.reason) : null
    if (field && reason) refusals.push({ field, reason })
  }

  const view: IdentityProfileView = {
    hasContent: false,
    partner1,
    partner2,
    nameQuality: names ? str(names.name_quality) : null,
    phantomPartner: names?.is_phantom_partner_relationship === true,
    residence,
    residenceQuote: residenceRaw ? str(residenceRaw.evidence_quote) : null,
    emotionalTruths,
    familyDynamics,
    culturalSignals,
    accessibilityNeeds,
    handles,
    refusals,
  }

  view.hasContent = Boolean(
    partner1 ||
      partner2 ||
      residence ||
      emotionalTruths.length ||
      familyDynamics.length ||
      culturalSignals.length ||
      accessibilityNeeds.length ||
      handles.length ||
      refusals.length,
  )

  return view
}
