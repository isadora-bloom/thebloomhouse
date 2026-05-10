/**
 * Bloom House — Wave 4 Identity Reconstruction Prompt
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; every populated claim has a verbatim evidence_quote)
 *   - bloom-wave4-identity-reconstruction.md (this prompt is the
 *     master prompt for the ONE Sonnet judge that replaces ~15
 *     heuristic detectors)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     is backed by a real callAI; Wave 4 extends that doctrine from
 *     labels to extractors)
 *
 * Prompt design rules:
 *   1. Every populated claim carries a verbatim evidence_quote pulled
 *      from the input. No fabrication.
 *   2. When evidence is ambiguous → return null + add an entry to
 *      `refusals` with the field and the reason. Better to refuse than
 *      to hallucinate.
 *   3. Sensitive themes (medical / grief / financial_stress /
 *      family_conflict / mental_health) get sensitive:true.
 *   4. Phantom-partner detection: identical first AND last (or
 *      identical first with no other distinguishing data) → set
 *      is_phantom_partner_relationship:true and partner2:null.
 *   5. Form-value / username / slug detection: single-token names that
 *      match common form-field labels OR look like
 *      "Mconn"/"Erinhorrigan"/"Benandalexwedding" → name_quality:'unknown'
 *      and add the offending value to refusals.
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 * The caller wraps callAI with the JSON-only suffix; this prompt
 * reinforces it.
 */

// Bumping this constant forces every read surface to either accept the
// new prompt's output or explicitly version-pin. Threaded into
// api_costs.prompt_version so a regression audit can correlate cost +
// quality + prompt revision.
export const IDENTITY_RECONSTRUCTION_PROMPT_VERSION =
  'identity-reconstruction.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface NameClaim {
  first: string | null
  last: string | null
  confidence_0_100: number
  evidence_quote: string | null
}

export type NameQuality = 'high' | 'medium' | 'low' | 'unknown'

export interface NamesBlock {
  partner1: NameClaim | null
  partner2: NameClaim | null
  is_phantom_partner_relationship: boolean
  name_quality: NameQuality
}

export interface EmotionalTruth {
  theme: string
  evidence_quote: string
  confidence_0_100: number
  sensitive: boolean
}

export interface OccupationClaim {
  partner_role: 'partner1' | 'partner2'
  occupation: string
  evidence_quote: string
}

export interface ResidenceClaim {
  city: string | null
  state: string | null
  evidence_quote: string
}

export interface FamilyDynamicClaim {
  relationship: string
  signal: string
  evidence_quote: string
}

export interface VendorPreferenceClaim {
  vendor_type: string
  preference: string
  evidence_quote: string
}

export interface HandleClaim {
  platform: string
  handle: string
  evidence_quote: string
}

export interface AccessibilityClaim {
  need: string
  evidence_quote: string
}

export interface CulturalSignalClaim {
  signal: string
  evidence_quote: string
}

export interface RelationshipHistoryBlock {
  length_signal: string | null
  prior_engagement_signal: string | null
}

export interface DecisionDynamicsBlock {
  who_decides: string | null
  who_questions: string | null
  who_negotiates: string | null
}

export interface RefusalEntry {
  field: string
  reason: string
}

export interface CoupleIdentityProfile {
  names: NamesBlock
  emotional_truths: EmotionalTruth[]
  occupations: OccupationClaim[]
  residence: ResidenceClaim | null
  family_dynamics: FamilyDynamicClaim[]
  vendor_preferences: VendorPreferenceClaim[]
  handles: HandleClaim[]
  accessibility_needs: AccessibilityClaim[]
  cultural_signals: CulturalSignalClaim[]
  relationship_history: RelationshipHistoryBlock | null
  decision_dynamics: DecisionDynamicsBlock | null
  refusals: RefusalEntry[]
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface InteractionEvidence {
  index: number
  direction: 'inbound' | 'outbound'
  from_email: string | null
  from_name: string | null
  subject: string | null
  body: string | null
  timestamp: string | null
}

export interface CalculatorEvidence {
  index: number
  timestamp: string | null
  form_data: Record<string, unknown> | string
}

export interface HoneyBookEvidence {
  external_id: string | null
  client_name: string | null
  partner_name: string | null
  email: string | null
  phone: string | null
  team_members: unknown
  notes: string | null
}

export interface CalendarEvidence {
  index: number
  source: string
  title: string | null
  attendees: string | null
  timestamp: string | null
  notes: string | null
}

export interface ReviewEvidence {
  index: number
  reviewer_name: string | null
  source: string
  rating: number | null
  body: string | null
  date: string | null
}

export interface ContractEvidence {
  index: number
  filename: string | null
  extracted_text: string | null
  created_at: string | null
}

export interface PaymentEvidence {
  index: number
  amount: number | null
  payer_name: string | null
  notes: string | null
  paid_at: string | null
}

export interface HandleEvidence {
  platform: string
  handle: string
  signal_date: string | null
  context: string | null
}

export interface ReconstructionEvidence {
  weddingId: string
  venueLabel: string | null
  weddingShell: {
    inquiry_date: string | null
    wedding_date: string | null
    status: string | null
    source: string | null
    guest_count_estimate: number | null
    notes: string | null
  }
  people: Array<{
    role: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  }>
  interactions: InteractionEvidence[]
  calculators: CalculatorEvidence[]
  honeybook: HoneyBookEvidence | null
  calendars: CalendarEvidence[]
  reviews: ReviewEvidence[]
  contracts: ContractEvidence[]
  payments: PaymentEvidence[]
  handles: HandleEvidence[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's forensic identity reconstructor.

Bloom is a forensic identity-reconstruction system for wedding venues.
For every prospective couple a venue interacts with, you reconstruct the
complete identity record from fragmented signals across email,
calculator submissions, CRM imports, calendar invites, reviews,
contracts, payments, and platform handles. The output you produce is
the substrate every other capability operates on — coordinator UI,
Sage drafting, risk flags, intel rollups. Errors here propagate
everywhere, so accuracy matters more than completeness.

## CORE RULES

1. **Verbatim evidence quotes.** Every populated claim MUST carry an
   \`evidence_quote\` that is a verbatim substring of the input. The
   quote should be short (≤200 chars) but specific enough that a
   coordinator reading it can verify the claim against the original
   signal. Do NOT paraphrase. Do NOT invent quotes. If you cannot find
   a verbatim quote, the field stays null and an entry goes in
   \`refusals\`.

2. **No fabrication.** When evidence is ambiguous or weak, return null
   for the field AND add an entry to \`refusals\` with
   \`{ field, reason }\`. Examples of what counts as too weak: a single
   capital-letter token whose origin you cannot trace; a name that
   appears in a quoted email signature you can't tell is the sender's;
   an inferred occupation from a single mention.

3. **Sensitive theme tagging.** Emotional truths whose theme is
   medical, grief, financial_stress, family_conflict, or mental_health
   MUST be tagged \`sensitive: true\`. Read surfaces will use this to
   refuse to quote them back at the couple. When in doubt, prefer
   sensitive:true.

4. **Phantom-partner detection.** A "phantom partner2" is when the
   evidence shows partner1 + partner2 are actually the same person, or
   when partner2 has no real distinguishing identity signal:
   - Same first AND same last name as partner1 with no other
     distinguishing data → \`is_phantom_partner_relationship: true\`,
     \`partner2: null\`.
   - Same first name as partner1, partner2 has no last name, no own
     email, never appears as the sender of an email, no other
     distinguishing context → \`is_phantom_partner_relationship: true\`,
     \`partner2: null\`.
   - Otherwise (real partner2 with own email, own signature, own
     family role mentioned, etc.) → return both partners and
     \`is_phantom_partner_relationship: false\`.
   Specific shapes seen in live data and explicitly phantom:
     "Hannah Lord & Hannah Lord", "Brett & Brett", "Sarah & Sarah".

5. **Form-value / username / slug detection.** Reject these patterns
   as names — set \`name_quality: 'unknown'\` and add the offending
   value to \`refusals\`:
   - Single-token names that look like form-field bleed:
     "Whole Weekend", "Final Walkthrough", "Tour Date", "Estimate".
   - Email-username slugs concatenated as a name:
     "Mconn", "Erinhorrigan", "Benandalexwedding", "Twisters42".
   - Names that are clearly a venue / property descriptor, not a
     person.
   When you do this, still try to recover the REAL name from elsewhere
   in the evidence (signatures, calculator forms, contracts). If a
   real name emerges, use that and don't downgrade name_quality.

6. **Name quality grading.** \`name_quality\` is the overall
   confidence in the picked names:
   - \`high\` — both partners (or partner1 alone, with phantom flag)
     have full first+last from a strong source (contract signer,
     calculator submission, explicit signature, HoneyBook record).
   - \`medium\` — at least partner1 has full first+last, but the
     evidence comes from a single email From-name and no signature
     or contract corroborates it.
   - \`low\` — only first names, or partner2 is a guess from a
     single mention, or the strongest signal is a slug-shaped handle.
   - \`unknown\` — the input contains no parseable name signal, or
     every candidate was a form-value / slug / venue descriptor.

7. **Confidence scores (0-100).** Per-claim integers:
   - 95-100: contract / calculator form / HoneyBook record / explicit
     coordinator-typed value.
   - 75-94:  email signature / repeated mention across multiple
     interactions.
   - 50-74:  single-source mention with corroborating shape (proper
     capitalization, common name, plausible context).
   - 25-49:  body extraction with weak shape signal.
   - 0-24:   slug / handle / inferred from a fragment.
   Anything below 25 should usually be a refusal instead.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "names": {
    "partner1": {
      "first": string | null,
      "last": string | null,
      "confidence_0_100": integer 0-100,
      "evidence_quote": string | null
    } | null,
    "partner2": same shape as partner1 | null,
    "is_phantom_partner_relationship": boolean,
    "name_quality": "high" | "medium" | "low" | "unknown"
  },
  "emotional_truths": [
    {
      "theme": string,
      "evidence_quote": string,
      "confidence_0_100": integer,
      "sensitive": boolean
    }
  ],
  "occupations": [
    {
      "partner_role": "partner1" | "partner2",
      "occupation": string,
      "evidence_quote": string
    }
  ],
  "residence": {
    "city": string | null,
    "state": string | null,
    "evidence_quote": string
  } | null,
  "family_dynamics": [
    {
      "relationship": string,
      "signal": string,
      "evidence_quote": string
    }
  ],
  "vendor_preferences": [
    {
      "vendor_type": string,
      "preference": string,
      "evidence_quote": string
    }
  ],
  "handles": [
    {
      "platform": string,
      "handle": string,
      "evidence_quote": string
    }
  ],
  "accessibility_needs": [
    {
      "need": string,
      "evidence_quote": string
    }
  ],
  "cultural_signals": [
    {
      "signal": string,
      "evidence_quote": string
    }
  ],
  "relationship_history": {
    "length_signal": string | null,
    "prior_engagement_signal": string | null
  } | null,
  "decision_dynamics": {
    "who_decides": string | null,
    "who_questions": string | null,
    "who_negotiates": string | null
  } | null,
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Every array MAY be empty. \`refusals\` is the audit trail of every
ambiguity — fill it generously.

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence with section headers.
// ---------------------------------------------------------------------------

const MAX_INTERACTION_BODY_CHARS = 4000
const MAX_CONTRACT_TEXT_CHARS = 4000
const MAX_REVIEW_BODY_CHARS = 1500
const MAX_INTERACTIONS = 50

/** Truncate a body for prompt budget. Adds a [...truncated] marker so
 *  the model can reason about whether the truncation is hiding the
 *  evidence quote it would have used. */
function truncateBody(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated, ' + (text.length - max) + ' more chars]'
}

/** Pick at most N interactions, weighted to first-touch + most-recent. */
function pickInteractions(rows: InteractionEvidence[], cap: number): InteractionEvidence[] {
  if (rows.length <= cap) return rows
  // Sort newest-first by timestamp.
  const sorted = [...rows].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0
    return tb - ta
  })
  // Half from the most recent, half from the earliest (first-touch
  // matters because that's where original names often live).
  const halfRecent = Math.ceil(cap / 2)
  const halfEarliest = cap - halfRecent
  const recent = sorted.slice(0, halfRecent)
  const earliest = sorted.slice(-halfEarliest)
  // Dedupe by index.
  const seen = new Set<number>()
  const out: InteractionEvidence[] = []
  for (const row of [...recent, ...earliest]) {
    if (seen.has(row.index)) continue
    seen.add(row.index)
    out.push(row)
  }
  // Re-sort chronologically for the model's reading flow.
  return out.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0
    return ta - tb
  })
}

export function buildUserPrompt(evidence: ReconstructionEvidence): string {
  const lines: string[] = []

  lines.push('# COUPLE TO RECONSTRUCT')
  lines.push('')
  lines.push(`Wedding ID: ${evidence.weddingId}`)
  if (evidence.venueLabel) lines.push(`Venue: ${evidence.venueLabel}`)
  lines.push('')

  // ---- Wedding shell ----
  const shell = evidence.weddingShell
  lines.push('## Wedding shell (current schema columns — use as supporting context, NOT as the source of names):')
  lines.push(`- inquiry_date: ${shell.inquiry_date ?? '(none)'}`)
  lines.push(`- wedding_date: ${shell.wedding_date ?? '(none)'}`)
  lines.push(`- status: ${shell.status ?? '(none)'}`)
  lines.push(`- source: ${shell.source ?? '(none)'}`)
  lines.push(`- guest_count_estimate: ${shell.guest_count_estimate ?? '(none)'}`)
  if (shell.notes && shell.notes.trim()) {
    lines.push('- notes:')
    lines.push(truncateBody(shell.notes, 800) ?? '')
  }
  lines.push('')

  // ---- People rows ----
  lines.push('## People rows (the current canonical record — your job is to assess whether these are right):')
  if (evidence.people.length === 0) {
    lines.push('(no people rows yet)')
  } else {
    for (const p of evidence.people) {
      const name = [p.first_name ?? '(no first)', p.last_name ?? '(no last)'].join(' ')
      lines.push(`- role=${p.role ?? '(?)'} | name=${name} | email=${p.email ?? '(none)'} | phone=${p.phone ?? '(none)'}`)
    }
  }
  lines.push('')

  // ---- HoneyBook ----
  if (evidence.honeybook) {
    const hb = evidence.honeybook
    lines.push('## HoneyBook record (CRM import — strong identity signal):')
    if (hb.external_id) lines.push(`- external_id: ${hb.external_id}`)
    if (hb.client_name) lines.push(`- client_name: ${hb.client_name}`)
    if (hb.partner_name) lines.push(`- partner_name: ${hb.partner_name}`)
    if (hb.email) lines.push(`- email: ${hb.email}`)
    if (hb.phone) lines.push(`- phone: ${hb.phone}`)
    if (hb.team_members) lines.push(`- team_members: ${JSON.stringify(hb.team_members)}`)
    if (hb.notes) {
      lines.push('- notes:')
      lines.push(truncateBody(hb.notes, 1500) ?? '')
    }
    lines.push('')
  }

  // ---- Contracts ----
  if (evidence.contracts.length > 0) {
    lines.push('## Contracts (signer names are the strongest legal signal):')
    for (const c of evidence.contracts) {
      lines.push(`### Contract ${c.index} | filename=${c.filename ?? '(none)'} | created_at=${c.created_at ?? '(none)'}`)
      if (c.extracted_text) {
        lines.push(truncateBody(c.extracted_text, MAX_CONTRACT_TEXT_CHARS) ?? '')
      } else {
        lines.push('(no extracted text)')
      }
      lines.push('')
    }
  }

  // ---- Calculator submissions ----
  if (evidence.calculators.length > 0) {
    lines.push('## Calculator submissions (form-typed — usually high-quality names):')
    for (const c of evidence.calculators) {
      lines.push(`### Calculator submission ${c.index} | timestamp=${c.timestamp ?? '(none)'}`)
      const fd = typeof c.form_data === 'string' ? c.form_data : JSON.stringify(c.form_data, null, 2)
      lines.push(truncateBody(fd, 2000) ?? '')
      lines.push('')
    }
  }

  // ---- Calendar invites / Calendly ----
  if (evidence.calendars.length > 0) {
    lines.push('## Calendar invites + Calendly bookings:')
    for (const c of evidence.calendars) {
      lines.push(`### ${c.source} | ${c.title ?? '(no title)'} | ${c.timestamp ?? '(no time)'}`)
      if (c.attendees) lines.push(`Attendees: ${c.attendees}`)
      if (c.notes) lines.push(truncateBody(c.notes, 800) ?? '')
      lines.push('')
    }
  }

  // ---- Reviews ----
  if (evidence.reviews.length > 0) {
    lines.push('## Reviews (where reviewer name loosely matches the couple):')
    for (const r of evidence.reviews) {
      lines.push(`### Review ${r.index} | ${r.source} | reviewer=${r.reviewer_name ?? '(anon)'} | rating=${r.rating ?? '(?)'} | date=${r.date ?? '(none)'}`)
      if (r.body) lines.push(truncateBody(r.body, MAX_REVIEW_BODY_CHARS) ?? '')
      lines.push('')
    }
  }

  // ---- Cross-platform handles ----
  if (evidence.handles.length > 0) {
    lines.push('## Cross-platform handles seen for this couple:')
    for (const h of evidence.handles) {
      lines.push(`- ${h.platform}: ${h.handle} | seen=${h.signal_date ?? '(?)'} | ctx=${h.context ?? ''}`)
    }
    lines.push('')
  }

  // ---- Payments ----
  if (evidence.payments.length > 0) {
    lines.push('## Payments:')
    for (const p of evidence.payments) {
      lines.push(`- ${p.paid_at ?? '(no date)'} | amount=${p.amount ?? '(?)'} | payer=${p.payer_name ?? '(?)'} | notes=${p.notes ?? ''}`)
    }
    lines.push('')
  }

  // ---- Interactions (last because they're the longest section) ----
  const picked = pickInteractions(evidence.interactions, MAX_INTERACTIONS)
  lines.push(`## Email interactions (${picked.length} of ${evidence.interactions.length} shown — first-touch + most-recent prioritised):`)
  if (picked.length === 0) {
    lines.push('(no interactions)')
  } else {
    for (const i of picked) {
      lines.push(`### Interaction ${i.index} | ${i.direction} | ${i.timestamp ?? '(no time)'}`)
      lines.push(`From: ${i.from_name ?? '(no name)'} <${i.from_email ?? '(no email)'}>`)
      lines.push(`Subject: ${i.subject ?? '(no subject)'}`)
      lines.push('Body:')
      lines.push(truncateBody(i.body, MAX_INTERACTION_BODY_CHARS) ?? '(no body)')
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('Reconstruct the couple identity profile from this evidence. Return ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Manual validator — Zod isn't in the deps, and a focused validator
// catches the failure modes that actually matter (missing required keys,
// wrong primitive types, refusal-array shape).
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  profile: CoupleIdentityProfile
}

export type ValidationResult = ValidationSuccess | ValidationFailure

function isString(v: unknown): v is string {
  return typeof v === 'string'
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean'
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || isString(v)
}

function validateNameClaim(value: unknown, path: string): NameClaim | null | string {
  if (value === null) return null
  if (!isObject(value)) return `${path} must be object or null`
  const first = value.first
  const last = value.last
  const conf = value.confidence_0_100
  const quote = value.evidence_quote
  if (!isStringOrNull(first)) return `${path}.first must be string|null`
  if (!isStringOrNull(last)) return `${path}.last must be string|null`
  if (!isNumber(conf)) return `${path}.confidence_0_100 must be number`
  if (!isStringOrNull(quote)) return `${path}.evidence_quote must be string|null`
  return {
    first: first ?? null,
    last: last ?? null,
    confidence_0_100: Math.max(0, Math.min(100, Math.round(conf))),
    evidence_quote: quote ?? null,
  }
}

/**
 * Validate the JSON the model returned. Returns ok:true with the
 * canonicalised profile, or ok:false with a string describing the first
 * shape error encountered. Permissive on optional fields (treats
 * missing-or-null as empty array / null) but strict on required shape.
 */
export function validateCoupleIdentityProfile(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  // names
  const namesRaw = raw.names
  if (!isObject(namesRaw)) return { ok: false, error: 'names must be an object' }

  const partner1 = validateNameClaim(namesRaw.partner1, 'names.partner1')
  if (typeof partner1 === 'string') return { ok: false, error: partner1 }
  const partner2 = validateNameClaim(namesRaw.partner2, 'names.partner2')
  if (typeof partner2 === 'string') return { ok: false, error: partner2 }

  const isPhantom = namesRaw.is_phantom_partner_relationship
  if (!isBoolean(isPhantom)) return { ok: false, error: 'names.is_phantom_partner_relationship must be boolean' }

  const nq = namesRaw.name_quality
  if (!isString(nq) || !['high', 'medium', 'low', 'unknown'].includes(nq)) {
    return { ok: false, error: 'names.name_quality must be "high"|"medium"|"low"|"unknown"' }
  }
  const nameQuality = nq as NameQuality

  // emotional_truths
  const truthsRaw = raw.emotional_truths ?? []
  if (!isArray(truthsRaw)) return { ok: false, error: 'emotional_truths must be array' }
  const emotional_truths: EmotionalTruth[] = []
  for (let idx = 0; idx < truthsRaw.length; idx++) {
    const t = truthsRaw[idx]
    if (!isObject(t)) return { ok: false, error: `emotional_truths[${idx}] must be object` }
    if (!isString(t.theme)) return { ok: false, error: `emotional_truths[${idx}].theme must be string` }
    if (!isString(t.evidence_quote)) return { ok: false, error: `emotional_truths[${idx}].evidence_quote must be string` }
    if (!isNumber(t.confidence_0_100)) return { ok: false, error: `emotional_truths[${idx}].confidence_0_100 must be number` }
    if (!isBoolean(t.sensitive)) return { ok: false, error: `emotional_truths[${idx}].sensitive must be boolean` }
    emotional_truths.push({
      theme: t.theme,
      evidence_quote: t.evidence_quote,
      confidence_0_100: Math.max(0, Math.min(100, Math.round(t.confidence_0_100))),
      sensitive: t.sensitive,
    })
  }

  // occupations
  const occRaw = raw.occupations ?? []
  if (!isArray(occRaw)) return { ok: false, error: 'occupations must be array' }
  const occupations: OccupationClaim[] = []
  for (let idx = 0; idx < occRaw.length; idx++) {
    const o = occRaw[idx]
    if (!isObject(o)) return { ok: false, error: `occupations[${idx}] must be object` }
    const role = o.partner_role
    if (role !== 'partner1' && role !== 'partner2') {
      return { ok: false, error: `occupations[${idx}].partner_role must be "partner1"|"partner2"` }
    }
    if (!isString(o.occupation)) return { ok: false, error: `occupations[${idx}].occupation must be string` }
    if (!isString(o.evidence_quote)) return { ok: false, error: `occupations[${idx}].evidence_quote must be string` }
    occupations.push({ partner_role: role, occupation: o.occupation, evidence_quote: o.evidence_quote })
  }

  // residence
  let residence: ResidenceClaim | null = null
  if (raw.residence !== null && raw.residence !== undefined) {
    if (!isObject(raw.residence)) return { ok: false, error: 'residence must be object|null' }
    const r = raw.residence
    if (!isStringOrNull(r.city)) return { ok: false, error: 'residence.city must be string|null' }
    if (!isStringOrNull(r.state)) return { ok: false, error: 'residence.state must be string|null' }
    if (!isString(r.evidence_quote)) return { ok: false, error: 'residence.evidence_quote must be string' }
    residence = { city: r.city ?? null, state: r.state ?? null, evidence_quote: r.evidence_quote }
  }

  // family_dynamics
  const famRaw = raw.family_dynamics ?? []
  if (!isArray(famRaw)) return { ok: false, error: 'family_dynamics must be array' }
  const family_dynamics: FamilyDynamicClaim[] = []
  for (let idx = 0; idx < famRaw.length; idx++) {
    const f = famRaw[idx]
    if (!isObject(f)) return { ok: false, error: `family_dynamics[${idx}] must be object` }
    if (!isString(f.relationship)) return { ok: false, error: `family_dynamics[${idx}].relationship must be string` }
    if (!isString(f.signal)) return { ok: false, error: `family_dynamics[${idx}].signal must be string` }
    if (!isString(f.evidence_quote)) return { ok: false, error: `family_dynamics[${idx}].evidence_quote must be string` }
    family_dynamics.push({ relationship: f.relationship, signal: f.signal, evidence_quote: f.evidence_quote })
  }

  // vendor_preferences
  const vpRaw = raw.vendor_preferences ?? []
  if (!isArray(vpRaw)) return { ok: false, error: 'vendor_preferences must be array' }
  const vendor_preferences: VendorPreferenceClaim[] = []
  for (let idx = 0; idx < vpRaw.length; idx++) {
    const v = vpRaw[idx]
    if (!isObject(v)) return { ok: false, error: `vendor_preferences[${idx}] must be object` }
    if (!isString(v.vendor_type)) return { ok: false, error: `vendor_preferences[${idx}].vendor_type must be string` }
    if (!isString(v.preference)) return { ok: false, error: `vendor_preferences[${idx}].preference must be string` }
    if (!isString(v.evidence_quote)) return { ok: false, error: `vendor_preferences[${idx}].evidence_quote must be string` }
    vendor_preferences.push({ vendor_type: v.vendor_type, preference: v.preference, evidence_quote: v.evidence_quote })
  }

  // handles
  const hRaw = raw.handles ?? []
  if (!isArray(hRaw)) return { ok: false, error: 'handles must be array' }
  const handles: HandleClaim[] = []
  for (let idx = 0; idx < hRaw.length; idx++) {
    const h = hRaw[idx]
    if (!isObject(h)) return { ok: false, error: `handles[${idx}] must be object` }
    if (!isString(h.platform)) return { ok: false, error: `handles[${idx}].platform must be string` }
    if (!isString(h.handle)) return { ok: false, error: `handles[${idx}].handle must be string` }
    if (!isString(h.evidence_quote)) return { ok: false, error: `handles[${idx}].evidence_quote must be string` }
    handles.push({ platform: h.platform, handle: h.handle, evidence_quote: h.evidence_quote })
  }

  // accessibility_needs
  const accRaw = raw.accessibility_needs ?? []
  if (!isArray(accRaw)) return { ok: false, error: 'accessibility_needs must be array' }
  const accessibility_needs: AccessibilityClaim[] = []
  for (let idx = 0; idx < accRaw.length; idx++) {
    const a = accRaw[idx]
    if (!isObject(a)) return { ok: false, error: `accessibility_needs[${idx}] must be object` }
    if (!isString(a.need)) return { ok: false, error: `accessibility_needs[${idx}].need must be string` }
    if (!isString(a.evidence_quote)) return { ok: false, error: `accessibility_needs[${idx}].evidence_quote must be string` }
    accessibility_needs.push({ need: a.need, evidence_quote: a.evidence_quote })
  }

  // cultural_signals
  const csRaw = raw.cultural_signals ?? []
  if (!isArray(csRaw)) return { ok: false, error: 'cultural_signals must be array' }
  const cultural_signals: CulturalSignalClaim[] = []
  for (let idx = 0; idx < csRaw.length; idx++) {
    const c = csRaw[idx]
    if (!isObject(c)) return { ok: false, error: `cultural_signals[${idx}] must be object` }
    if (!isString(c.signal)) return { ok: false, error: `cultural_signals[${idx}].signal must be string` }
    if (!isString(c.evidence_quote)) return { ok: false, error: `cultural_signals[${idx}].evidence_quote must be string` }
    cultural_signals.push({ signal: c.signal, evidence_quote: c.evidence_quote })
  }

  // relationship_history
  let relationship_history: RelationshipHistoryBlock | null = null
  if (raw.relationship_history !== null && raw.relationship_history !== undefined) {
    if (!isObject(raw.relationship_history)) return { ok: false, error: 'relationship_history must be object|null' }
    const rh = raw.relationship_history
    if (!isStringOrNull(rh.length_signal)) return { ok: false, error: 'relationship_history.length_signal must be string|null' }
    if (!isStringOrNull(rh.prior_engagement_signal)) return { ok: false, error: 'relationship_history.prior_engagement_signal must be string|null' }
    relationship_history = {
      length_signal: rh.length_signal ?? null,
      prior_engagement_signal: rh.prior_engagement_signal ?? null,
    }
  }

  // decision_dynamics
  let decision_dynamics: DecisionDynamicsBlock | null = null
  if (raw.decision_dynamics !== null && raw.decision_dynamics !== undefined) {
    if (!isObject(raw.decision_dynamics)) return { ok: false, error: 'decision_dynamics must be object|null' }
    const dd = raw.decision_dynamics
    if (!isStringOrNull(dd.who_decides)) return { ok: false, error: 'decision_dynamics.who_decides must be string|null' }
    if (!isStringOrNull(dd.who_questions)) return { ok: false, error: 'decision_dynamics.who_questions must be string|null' }
    if (!isStringOrNull(dd.who_negotiates)) return { ok: false, error: 'decision_dynamics.who_negotiates must be string|null' }
    decision_dynamics = {
      who_decides: dd.who_decides ?? null,
      who_questions: dd.who_questions ?? null,
      who_negotiates: dd.who_negotiates ?? null,
    }
  }

  // refusals
  const refRaw = raw.refusals ?? []
  if (!isArray(refRaw)) return { ok: false, error: 'refusals must be array' }
  const refusals: RefusalEntry[] = []
  for (let idx = 0; idx < refRaw.length; idx++) {
    const r = refRaw[idx]
    if (!isObject(r)) return { ok: false, error: `refusals[${idx}] must be object` }
    if (!isString(r.field)) return { ok: false, error: `refusals[${idx}].field must be string` }
    if (!isString(r.reason)) return { ok: false, error: `refusals[${idx}].reason must be string` }
    refusals.push({ field: r.field, reason: r.reason })
  }

  return {
    ok: true,
    profile: {
      names: {
        partner1,
        partner2,
        is_phantom_partner_relationship: isPhantom,
        name_quality: nameQuality,
      },
      emotional_truths,
      occupations,
      residence,
      family_dynamics,
      vendor_preferences,
      handles,
      accessibility_needs,
      cultural_signals,
      relationship_history,
      decision_dynamics,
      refusals,
    },
  }
}
