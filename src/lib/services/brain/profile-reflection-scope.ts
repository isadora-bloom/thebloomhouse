/**
 * What the couple's own assistant may reflect back at them.
 *
 * W52 of NOVEMBER-PLAN.md wave 7. The couple portal chat gets a slice of
 * the reconstructed identity profile so it can say "you mentioned wanting
 * the ceremony outdoors" instead of asking a couple to repeat themselves.
 * That is warmth. The same profile also holds inferred themes, scores,
 * family read-outs and handles, and reading any of those back is
 * surveillance. This file is the line between the two, written down once
 * so it cannot drift.
 *
 * The doctrine it serves
 * ----------------------
 * Three existing rules, none of which lived in one place before:
 *
 *   - `src/config/prompts/couple-rules.ts` TENANT ISOLATION: never
 *     mention another couple's wedding, and never share a venue-specific
 *     cross-couple pattern. So nothing aggregated reaches this scope
 *     either, not even as a comparison.
 *   - `src/config/prompts/universal-rules.ts` SOFT-CONTEXT NOTES POLICY:
 *     notes shape the voice, they are never quoted back, and a sensitive
 *     note is never referenced by content at all.
 *   - `src/lib/services/brain/re-engagement-drafter.ts`: naming a count
 *     of someone's own behaviour back at them is "surveillance and
 *     creepy", banned outright.
 *
 * The rule this file adds, in one line: the assistant may repeat what the
 * couple themselves said, and may never repeat what Bloom worked out
 * about them.
 *
 * How it works
 * ------------
 * `scopeProfileForReflection` takes the whole `profile` jsonb exactly as
 * `getCoupleJourney` returns it and copies out a short allow-list. It is
 * a copy, not a filter: an unrecognised key added to the profile by a
 * later reconstruction prompt is dropped by default rather than leaking
 * on the strength of nobody having thought about it yet. Every excluded
 * block is named in `withheld` with the reason, so the exclusion is
 * auditable and the tests can assert on it.
 *
 * Nothing here reads the database, and nothing here writes. Pure.
 * Unit-tested in ./__tests__/profile-reflection-scope.test.ts.
 */

// ─────────────────────────────────────────────────────────────────────
// The allow-list, stated as data
// ─────────────────────────────────────────────────────────────────────

/**
 * Profile blocks that may be reflected back, and the single reason each
 * one qualifies: the couple said it about themselves, in their own
 * words, to this venue.
 */
export const REFLECTABLE_BLOCKS = [
  'names.partner1.first',
  'names.partner2.first',
  'vendor_preferences',
] as const

/**
 * Every other block the profile can carry, with the reason it stays on
 * the operator's side of the wall. The list is exhaustive against
 * `CoupleIdentityProfile` in `src/config/prompts/identity-reconstruction.ts`
 * as of 2026-09-14; a test asserts that, so a new block added to the
 * profile fails here until somebody decides which side it belongs on.
 */
export const WITHHELD_REASONS: Readonly<Record<string, string>> = {
  'names.partner1.last': 'A surname is not what a couple calls each other.',
  'names.partner2.last': 'A surname is not what a couple calls each other.',
  'names.confidence_0_100': 'A score Bloom put on its own reading. Never a couple-facing fact.',
  'names.name_quality': 'A score Bloom put on its own reading. Never a couple-facing fact.',
  'names.is_phantom_partner_relationship':
    'An internal flag about a partner who was never named. Saying it back would be an accusation.',
  evidence_quote:
    'The verbatim line Bloom lifted from their own message. Quoting it back is the surveillance feeling, exactly.',
  emotional_truths:
    'Inferred themes, some flagged sensitive. The soft-context policy says these shape the voice and are never echoed.',
  occupations: 'Worked out from evidence, not told to the assistant. Reading a job back is unnerving.',
  residence: 'Where they live, worked out from evidence. Nothing in a wedding answer needs it said aloud.',
  family_dynamics:
    'Third party. A read on a parent or a sibling, usually from somebody else’s words about them.',
  vendor_preferences_evidence: 'The quote behind the preference. The preference is enough.',
  handles: 'Social accounts matched to them. Naming one is the clearest possible surveillance tell.',
  accessibility_needs:
    'Health-adjacent. Let it shape what the assistant suggests; never say the need back to them.',
  cultural_signals: 'Inferred from evidence. A guess about who somebody is, dressed as a fact.',
  relationship_history: 'Inferred. How long they have been together is not the assistant’s to raise.',
  decision_dynamics:
    'A read on which of them decides and which of them questions. Scored, internal, and unkind out loud.',
  refusals: 'Bloom’s own record of what it would not guess at. Internal bookkeeping.',
}

/**
 * Fields that live outside the identity profile and must never travel
 * with it into a couple-facing prompt, listed so the intent is explicit
 * rather than implied by their absence. Anything derived, scored or
 * written by the venue about the couple belongs here.
 */
export const NEVER_COUPLE_FACING = [
  'ghost_risk',
  'ghostRisk',
  'heat',
  'heat_score',
  'heatScore',
  'lifecycle_state',
  'lifecycleState',
  'close_probability',
  'engagement_score',
  'coordinator_notes',
  'coordinatorNotes',
  'internal_notes',
  'persona',
  'booking_value',
] as const

// ─────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────

export interface ReflectableItem {
  /** What the thing is about, in the couple's own terms ("photographer"). */
  label: string
  /** What they said about it ("wants the ceremony outdoors"). */
  detail: string
}

export interface WithheldEntry {
  /** The profile block that was left out. */
  field: string
  /** Why, in one plain sentence. */
  reason: string
}

export interface ProfileReflectionScope {
  /** False when there is nothing the assistant may repeat. The caller
   *  renders no block at all rather than an empty one. */
  hasContent: boolean
  /** First names only, in the order the profile records them. These are
   *  the names the couple use for each other. */
  firstNames: string[]
  /** Things they said they want, as they said them. */
  statedPriorities: ReflectableItem[]
  /** Dates the couple themselves gave. Supplied by the caller from the
   *  couple's own record, never inferred here. */
  statedDates: ReflectableItem[]
  /** Every block considered and left out, with the reason. Auditable on
   *  purpose: an exclusion nobody can see is an exclusion nobody
   *  maintains. */
  withheld: WithheldEntry[]
}

export interface ReflectionInput {
  /** The `profile` jsonb, exactly as `getCoupleJourney` returns it in
   *  `CoupleJourney.identityProfile`. */
  profile: Record<string, unknown> | null
  /** Dates the couple gave the venue directly, already held on their own
   *  record (their wedding date, say). Passed in rather than read here so
   *  this module stays pure and so a caller cannot smuggle in a date the
   *  couple never stated. */
  statedDates?: ReadonlyArray<{ label: string; value: string | null | undefined }>
}

// ─────────────────────────────────────────────────────────────────────
// Defensive readers. Same posture as identity-profile-view.ts: a claim
// that is not the shape we expect is absent, never half-read.
// ─────────────────────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/** A first name and nothing else. A value carrying a space is a full
 *  name that found its way into the `first` slot; take the first word
 *  rather than reflecting a surname by accident. */
function firstNameOnly(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const head = s.split(/\s+/)[0]
  return head && head.length > 0 ? head : null
}

// ─────────────────────────────────────────────────────────────────────
// The scope
// ─────────────────────────────────────────────────────────────────────

function withheldList(): WithheldEntry[] {
  return Object.entries(WITHHELD_REASONS).map(([field, reason]) => ({ field, reason }))
}

/**
 * Copy out the part of the profile the couple's own assistant may repeat
 * back to them. Everything not on the allow-list is dropped and named in
 * `withheld`.
 *
 * Returns `hasContent: false` on a missing or empty profile so the caller
 * adds no prompt block at all, rather than one that says nothing.
 */
export function scopeProfileForReflection(input: ReflectionInput): ProfileReflectionScope {
  const withheld = withheldList()
  const profile = input.profile

  const firstNames: string[] = []
  const statedPriorities: ReflectableItem[] = []

  if (profile) {
    const names = obj(profile.names)
    for (const role of ['partner1', 'partner2'] as const) {
      const claim = obj(names?.[role])
      const first = firstNameOnly(claim?.first)
      // A repeated name is one person recorded twice, not two people.
      if (first && !firstNames.some((n) => n.toLowerCase() === first.toLowerCase())) {
        firstNames.push(first)
      }
    }

    // Vendor preferences are the one profile block a couple actually
    // stated about their own wedding: "wants the ceremony outdoors",
    // "no band". The evidence quote behind each one is deliberately
    // left on the floor — the preference is the fact, the quote is the
    // surveillance.
    for (const raw of arr(profile.vendor_preferences)) {
      const claim = obj(raw)
      if (!claim) continue
      const label = str(claim.vendor_type)
      const detail = str(claim.preference)
      if (!label || !detail) continue
      statedPriorities.push({ label, detail })
    }
  }

  const statedDates: ReflectableItem[] = []
  for (const d of input.statedDates ?? []) {
    const label = str(d.label)
    const detail = str(d.value)
    if (!label || !detail) continue
    statedDates.push({ label, detail })
  }

  return {
    hasContent: firstNames.length > 0 || statedPriorities.length > 0 || statedDates.length > 0,
    firstNames,
    statedPriorities,
    statedDates,
    withheld,
  }
}

// ─────────────────────────────────────────────────────────────────────
// The prompt block
// ─────────────────────────────────────────────────────────────────────

/**
 * The instruction that travels with the block. Without it a model that
 * is handed a list of facts will read them out as a list, which is the
 * surveillance register even when every fact is allowed.
 */
const REFLECTION_RULES = [
  'These are things this couple told you or the venue themselves. You may refer back to them the way a friend would, in passing, when it makes an answer more useful.',
  'Say "you mentioned" or "you said", because they did.',
  'Never read this block out as a list, never open a reply by reciting it, and never say how you know any of it.',
  'Never say anything about this couple that is not written above: no scores, no likelihoods, no read on which of them decides, nothing about their families, their jobs, where they live, or their social accounts. If it is not in this block, you do not know it.',
].join('\n')

/**
 * Render the scoped slice as a prompt block, or `''` when there is
 * nothing to reflect. The empty string drops out of sage.ts's
 * `.filter(Boolean)` join, same as every other optional block there.
 */
export function formatProfileReflectionBlock(scope: ProfileReflectionScope): string {
  if (!scope.hasContent) return ''

  const lines: string[] = []
  if (scope.firstNames.length > 0) {
    lines.push(`They go by: ${scope.firstNames.join(' and ')}.`)
  }
  for (const d of scope.statedDates) {
    lines.push(`${d.label}: ${d.detail} (they gave you this).`)
  }
  for (const p of scope.statedPriorities) {
    lines.push(`On ${p.label}, they said: ${p.detail}`)
  }

  return `\n--- WHAT THEY HAVE TOLD YOU (SAFE TO MENTION) ---\n${lines.join('\n')}\n\n${REFLECTION_RULES}\n--- END WHAT THEY HAVE TOLD YOU ---\n`
}
