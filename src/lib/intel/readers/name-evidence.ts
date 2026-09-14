/**
 * The name-evidence chain for one couple.
 *
 * What this is honest about
 * -------------------------
 * The evidence chain itself (`people.name_evidence`, migration 255) has
 * no spine equivalent. `couples` carries the picked names and, since
 * migration 398, the handle map, but nothing on the spine records WHY a
 * name was picked: which email signature, which contract signer, which
 * tour transcript, at what confidence, pinned by whom. That ladder still
 * lives on the legacy person rows, and pretending otherwise would mean
 * deleting the audit trail the panel exists to show.
 *
 * So this reader does two things and says which is which:
 *
 *   1. The couple's own facts — names, handles, whether the forensic
 *      profile called this a single decision-maker — come from the spine
 *      (`couples`, `couple_identity_profile`).
 *   2. The evidence chain comes from `people`, reached through the
 *      couple's `source_wedding_id`. This is the ONE place in the intel
 *      layer that knows that join. Every route and panel above it is
 *      keyed on the couple id.
 *
 * When the couple has no mirrored wedding there are no person rows to
 * read, and the reader returns the spine names with an empty chain
 * rather than an error. "We have the name but not the paper trail" is
 * the truth in that case, and it renders as the panel's existing
 * no-evidence-yet state.
 *
 * Injectable client, no service-role import, no network. Unit-tested in
 * ./__tests__/name-evidence.test.ts against the in-memory fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface NameEvidenceEntry {
  source?: string
  value?: { first?: string | null; last?: string | null } | null
  raw?: string
  confidence?: number | null
  captured_at?: string | null
  interaction_id?: string | null
  pinned?: boolean
  superseded?: boolean
}

export interface NameEvidencePartner {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  display_handle: string | null
  name_confidence: number | null
  name_picked_source: string | null
  email: string | null
  phone: string | null
  name_evidence: NameEvidenceEntry[]
}

export interface CoupleNameEvidence {
  coupleId: string
  partners: NameEvidencePartner[]
  /** 1 when the forensic profile judged this a single decision-maker.
   *  Null when unknown — never 2 by assumption. */
  partnerCount: number | null
  /** `couples.handles` (migration 398). The spine's handle map, and the
   *  only one a surface should render: HANDLE-IDENTITY-SPEC.md §1 puts a
   *  handle on the couple, not on a person row. The legacy per-person
   *  twin is deliberately not read here. */
  handles: Record<string, string>
  /** True when the evidence chain could not be read because the couple
   *  has no mirrored wedding. Lets a surface distinguish "no evidence"
   *  from "nowhere to look". */
  chainUnavailable: boolean
}

const FULL_SELECT =
  'id, role, first_name, last_name, email, phone, name_evidence, ' +
  'display_handle, name_confidence, name_picked_source'
const LEGACY_SELECT = 'id, role, first_name, last_name, email, phone'

interface CoupleRow {
  id: string
  venue_id: string
  source_wedding_id: string | null
  handles: Record<string, string> | null
  merged_into_id: string | null
}

/** Pinned first, then confidence descending, then most recent. The order
 *  the panel renders and the order an operator reasons in. */
export function sortEvidence(entries: readonly NameEvidenceEntry[]): NameEvidenceEntry[] {
  return [...entries].sort((a, b) => {
    const aPinned = a.pinned === true ? 1 : 0
    const bPinned = b.pinned === true ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    const aConf = typeof a.confidence === 'number' ? a.confidence : -1
    const bConf = typeof b.confidence === 'number' ? b.confidence : -1
    if (aConf !== bConf) return bConf - aConf
    return (b.captured_at ?? '').localeCompare(a.captured_at ?? '')
  })
}

function toPartner(r: Record<string, unknown>): NameEvidencePartner {
  const rawEvidence = (r.name_evidence as NameEvidenceEntry[] | null) ?? []
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.filter((e) => e && typeof e === 'object')
    : []
  return {
    id: r.id as string,
    role: r.role as string,
    first_name: (r.first_name as string | null) ?? null,
    last_name: (r.last_name as string | null) ?? null,
    display_handle: (r.display_handle as string | null) ?? null,
    name_confidence: typeof r.name_confidence === 'number' ? (r.name_confidence as number) : null,
    name_picked_source: (r.name_picked_source as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    name_evidence: sortEvidence(evidence),
  }
}

/** `couple_identity_profile.profile.names.is_phantom_partner_relationship`
 *  is the Wave-4 judge's verdict on whether there is a second decision
 *  maker. True means one. Anything else means we do not know, and the
 *  panel shows no badge rather than a confident "two". */
function partnerCountFromProfile(profile: unknown): number | null {
  if (!profile || typeof profile !== 'object') return null
  const names = (profile as { names?: unknown }).names
  if (!names || typeof names !== 'object') return null
  const phantom = (names as { is_phantom_partner_relationship?: unknown })
    .is_phantom_partner_relationship
  return phantom === true ? 1 : null
}

/**
 * Name evidence for one couple, venue-scoped.
 *
 * Returns null when the venue does not own the couple — the same
 * honest-empty contract the canonical readers keep, so a caller can
 * answer "not in scope" without a second tenancy query.
 */
export async function loadCoupleNameEvidence(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
): Promise<CoupleNameEvidence | null> {
  if (!venueId || !coupleId) return null

  const { data: couple } = await supabase
    .from('couples')
    .select('id, venue_id, source_wedding_id, handles, merged_into_id')
    .eq('id', coupleId)
    .eq('venue_id', venueId)
    .maybeSingle<CoupleRow>()
  if (!couple || couple.merged_into_id) return null

  const handles = (couple.handles ?? {}) as Record<string, string>

  if (!couple.source_wedding_id) {
    return {
      coupleId,
      partners: [],
      partnerCount: null,
      handles,
      chainUnavailable: true,
    }
  }

  const weddingId = couple.source_wedding_id

  // Evidence chain. The mig-255 columns first; fall back when the column
  // has not shipped to this environment yet, because the panel has to
  // render on either side of that boundary.
  let rows: Array<Record<string, unknown>> = []
  const { data: fullRows, error: fullErr } = await supabase
    .from('people')
    .select(FULL_SELECT)
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
  if (fullErr) {
    const msg = (fullErr as { message?: string }).message ?? ''
    if (!/column .* does not exist/i.test(msg)) throw new Error(msg || 'people query failed')
    const legacy = await supabase
      .from('people')
      .select(LEGACY_SELECT)
      .eq('wedding_id', weddingId)
      .eq('venue_id', venueId)
    rows = (legacy.data ?? []) as unknown as Array<Record<string, unknown>>
  } else {
    rows = (fullRows ?? []) as unknown as Array<Record<string, unknown>>
  }

  const { data: profileRow } = await supabase
    .from('couple_identity_profile')
    .select('profile')
    .eq('wedding_id', weddingId)
    .maybeSingle<{ profile: unknown }>()

  return {
    coupleId,
    partners: rows
      .filter((r) => r.role === 'partner1' || r.role === 'partner2')
      .map(toPartner),
    partnerCount: partnerCountFromProfile(profileRow?.profile ?? null),
    handles,
    chainUnavailable: false,
  }
}
