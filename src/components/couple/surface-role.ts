/**
 * Who is looking at a couple-portal component.
 *
 * Two surfaces now render the same contract list and the same day-of
 * timeline: the couple's own portal, and the coordinator's wedding page
 * at /portal/weddings/[id]. The Monday walkthrough audit is the reason.
 * A coordinator sitting with a couple had a wedding page that said
 * "contract uploaded: yes" and a timeline they could read but not touch,
 * so the meeting kept bouncing to a second screen.
 *
 * The components are shared, not forked. What changes between the two is
 * described here, in one place, as data rather than as `role === 'couple'`
 * scattered through the JSX. Both roles read and write through the same
 * RLS policies: the couple through the couple-role grants of migration
 * 226, the coordinator through the venue_isolation policy of migration
 * 006. Neither path adds a route.
 *
 * Pure on purpose. No React, no Supabase, no browser. Unit-tested in
 * ./__tests__/surface-role.test.ts.
 */

export type CoupleSurfaceRole = 'couple' | 'coordinator'

/** How to name the person editing, in a sentence. */
export function editorNoun(role: CoupleSurfaceRole): string {
  return role === 'couple' ? 'the couple' : 'the coordinator'
}

// ─────────────────────────────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────────────────────────────

export interface ContractCapabilities {
  /** Read the list, the AI summary and the extracted text. Both roles. */
  canRead: boolean
  /** Filter by filename, vendor or analysis text. Both roles. */
  canSearch: boolean
  /** Follow the signed storage URL. Both roles, where the row has one. */
  canDownload: boolean
  /** Add a file. The couple owns their own paperwork. */
  canUpload: boolean
  /** Remove a file. Same reason. */
  canDelete: boolean
  /** Run the extraction and the AI summary over a file. */
  canAnalyse: boolean
  /** Open the assistant chat with the contract loaded. The chat route is
   *  couple-scoped, so the coordinator does not get this button rather
   *  than getting one that 404s. */
  canAskAssistant: boolean
  /** Ask a one-off question of a single contract, answered inline. */
  canAskInline: boolean
}

const COUPLE_CONTRACTS: ContractCapabilities = {
  canRead: true,
  canSearch: true,
  canDownload: true,
  canUpload: true,
  canDelete: true,
  canAnalyse: true,
  canAskAssistant: true,
  canAskInline: true,
}

const COORDINATOR_CONTRACTS: ContractCapabilities = {
  canRead: true,
  canSearch: true,
  canDownload: true,
  canUpload: false,
  canDelete: false,
  canAnalyse: false,
  canAskAssistant: false,
  canAskInline: false,
}

export function contractCapabilities(role: CoupleSurfaceRole): ContractCapabilities {
  return role === 'couple' ? COUPLE_CONTRACTS : COORDINATOR_CONTRACTS
}

// ─────────────────────────────────────────────────────────────────────
// Day-of timeline
// ─────────────────────────────────────────────────────────────────────

export interface TimelineCapabilities {
  /** Change settings, times, durations, notes and which events are in. */
  canEdit: boolean
  /** Write the blob back to `timeline.config_json`. */
  canSave: boolean
  /** Throw away every customisation and rebuild from the defaults. The
   *  couple keeps this; a coordinator doing it mid-meeting would wipe
   *  work the couple did at home with no undo. */
  canReset: boolean
  /** Add an event the template does not have. */
  canAddCustom: boolean
  /** Download the running order as a CSV. Both roles. */
  canExport: boolean
}

const COUPLE_TIMELINE: TimelineCapabilities = {
  canEdit: true,
  canSave: true,
  canReset: true,
  canAddCustom: true,
  canExport: true,
}

const COORDINATOR_TIMELINE: TimelineCapabilities = {
  canEdit: true,
  canSave: true,
  canReset: false,
  canAddCustom: true,
  canExport: true,
}

export function timelineCapabilities(role: CoupleSurfaceRole): TimelineCapabilities {
  return role === 'couple' ? COUPLE_TIMELINE : COORDINATOR_TIMELINE
}

// ─────────────────────────────────────────────────────────────────────
// Attribution
// ─────────────────────────────────────────────────────────────────────

/**
 * Who last saved the running order.
 *
 * The `timeline` table has no `edited_by` column, and this wave adds no
 * migration, so the attribution rides inside the `config_json` blob the
 * save already writes. Additive: every existing reader of that blob
 * (the couple page, the coordinator print page, the e2e seed) looks at
 * `config`, `events` and `customEvents` and ignores anything else.
 */
export interface TimelineEditedBy {
  role: CoupleSurfaceRole
  /** ISO instant of the save. */
  at: string
}

export function stampEditedBy(role: CoupleSurfaceRole, now: Date = new Date()): TimelineEditedBy {
  return { role, at: now.toISOString() }
}

/** Read an `editedBy` stamp back out of a saved blob, defensively. A blob
 *  written before this existed returns null, which reads as "we do not
 *  know" rather than as a guess. */
export function readEditedBy(raw: unknown): TimelineEditedBy | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const role = r.role
  const at = r.at
  if (role !== 'couple' && role !== 'coordinator') return null
  if (typeof at !== 'string' || at.trim() === '') return null
  return { role, at }
}

/** "Last saved by the coordinator" / "Last saved by the couple". Null when
 *  nothing has been stamped yet, so the caller drops the line instead of
 *  printing a blank. */
export function editedByLine(stamp: TimelineEditedBy | null): string | null {
  if (!stamp) return null
  return `Last saved by ${editorNoun(stamp.role)}`
}
