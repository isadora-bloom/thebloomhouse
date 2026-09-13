/**
 * CSV import rows → cascade signals → `linkSignal`.
 * W35, NOVEMBER-PLAN.md wave 5, 2026-09-12.
 *
 * What this closes
 * ----------------
 * Every ingestion path in the platform goes through `linkSignal` except
 * CSV import. Import still minted through the legacy `mintWedding` and
 * leaned on `mirrorCoupleFromWedding` to produce the spine row afterwards,
 * which meant the spine learned about an imported couple second-hand.
 * W25 taught the web-form adapter to read an Instagram column, W29 bolted
 * a handle stamp on after the row loop to get that value onto the couple,
 * and first_seen_at only moved for rows that happened to carry a handle.
 * Three patches around one missing thing: the import never handed the one
 * writer a signal.
 *
 * It does now. Each normalised row produces one `NormalizedSignal` per
 * interaction it carries plus a row-level anchor, and those go through
 * `linkSignal`, in time order, like every other channel. Handles,
 * first_seen_at, point zero, fragment promotion and the progression clock
 * all arrive through the cascade's own stamp rather than a second pass.
 *
 * ---------------------------------------------------------------------
 * ORDERING: the legacy wedding row is minted FIRST, then the signals.
 * ---------------------------------------------------------------------
 * Both orderings were on the table. Mint-first won on three counts.
 *
 *   1. The couples mirror upserts on `(venue_id, source_wedding_id)`.
 *      Mint-first means the couple that the mirror creates already
 *      carries the wedding id, so every signal for the row takes
 *      `linkSignal`'s `legacy_wedding_id` fast path and lands on that one
 *      couple. Reverse the order and the cascade mints a channel-scoped
 *      couple whose `source_wedding_id` is NULL; the mirror then finds no
 *      conflict row on its upsert key and inserts a SECOND couple for the
 *      same row. One CSV row, two couples, every time.
 *
 *   2. To make the reverse work, something would have to write
 *      `couples.source_wedding_id` onto the cascade-minted couple before
 *      the mirror ran. That something is not `linkSignal`, so it is a
 *      second spine writer, which is the exact thing this workstream is
 *      here to remove.
 *
 *   3. `mintWedding` fires the mirror without awaiting it (W19 found this
 *      on the demo reseed). The reverse ordering would race that
 *      in-flight mirror and lose non-deterministically. Mint-first lets
 *      us await a mirror of our own before any signal goes out, which
 *      turns the race into a wait. `ensureMirroredCouple` below is that
 *      wait: it reads the couple, and only mirrors again when the
 *      fire-and-forget one has not landed. The mirror is an idempotent
 *      upsert, so repeating it is safe.
 *
 * The cost of mint-first is that the legacy resolver, not the cascade,
 * gets first say on which couple a row belongs to. `findSpineCoupleWedding`
 * below buys most of that back: before the row mints anything, we ask the
 * spine whether a couple already holds this row's email or phone, and if
 * that couple carries a legacy wedding we import onto it. Those are the
 * two deterministic anchors `lock_and_mint_couple` re-checks on, nothing
 * fuzzier, and the lookup writes nothing. A couple the spine knows only as
 * channel-scoped (no legacy wedding) is left alone and the row mints its
 * own wedding: the candidate queue and the merge machinery already own
 * that reconciliation, and guessing here would fuse strangers.
 *
 * Progression
 * -----------
 * The per-interaction action types below are deliberately NOT
 * progression-eligible. A backfill of five-year-old emails must not bump
 * a couple's decay clock and make a cold lead look warm. The row anchor
 * uses the `crm_imported_*` vocabulary that `progression.ts` already maps
 * for the honeybook channel; on the other CSV channels it falls through to
 * null, which is the honest outcome until an event type and its migration
 * exist for them.
 *
 * Rerun safety
 * ------------
 * Two independent guards, both required.
 *   - The processed marker (`crm_import_rows`, migration 335) decides
 *     whether an interaction is new. An interaction whose marker could not
 *     be written produces NO signal, because we cannot tell a first import
 *     from a fifth. The swallowed-dedup rule: skip, never re-import.
 *   - `UNIQUE(venue_id, channel, external_id)` on touchpoints. Every
 *     external_id built here is a pure function of the import source, the
 *     row key and the interaction key, so a second upload of the same file
 *     returns 'duplicate' and writes nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSignal } from '@/lib/services/identity/sources/types'
import type {
  CrmSource,
  NormalisedInteractionRow,
  NormalisedLeadRow,
} from './index'

// ---------------------------------------------------------------------------
// Channel + action vocabulary
// ---------------------------------------------------------------------------

/**
 * The `touchpoints.channel` value for an import source. Free text by
 * schema (migration 346), but these are the values already in use
 * elsewhere in the codebase, so the intel surfaces group correctly.
 */
export function channelForCrmSource(crmSource: CrmSource): string {
  switch (crmSource) {
    case 'honeybook':
      return 'honeybook'
    case 'web_form':
      return 'web'
    case 'dubsado':
      return 'dubsado'
    case 'aisle_planner':
      return 'aisle_planner'
    case 'generic_csv':
    default:
      return 'csv_import'
  }
}

/** Row status → the `crm_imported_*` verb `progression.ts` already knows. */
function actionTypeForStatus(status: NormalisedLeadRow['status']): string {
  switch (status) {
    case 'booked':
    case 'completed':
      return 'crm_imported_booked'
    case 'lost':
    case 'cancelled':
      return 'crm_imported_lost'
    default:
      return 'crm_imported_inquiry'
  }
}

const ACTION_BY_INTERACTION_TYPE: Record<
  NormalisedInteractionRow['type'],
  string
> = {
  email: 'crm_email',
  call: 'crm_call',
  voicemail: 'crm_voicemail',
  sms: 'crm_sms',
  meeting: 'crm_meeting',
  web_form: 'crm_form_submit',
}

/** Interaction type plus direction. A web form only ever comes inbound. */
export function actionTypeForInteraction(i: NormalisedInteractionRow): string {
  const base = ACTION_BY_INTERACTION_TYPE[i.type] ?? 'crm_interaction'
  if (i.type === 'web_form') return base
  return `${base}_${i.direction}`
}

// ---------------------------------------------------------------------------
// Stable keys
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.@-]/g, '')
}

/**
 * A key for the row that survives a re-upload of the same file.
 *
 * The adapter's own `source_id` first (HoneyBook project name, a web-form
 * reference). Then the contact email, which is what actually identifies
 * the couple. Name plus date is the floor, and a row with none of those
 * is not importable identity anyway.
 */
export function rowKeyFor(row: NormalisedLeadRow): string {
  const sourceId = (row.source_id ?? '').trim()
  if (sourceId) return `id:${slug(sourceId)}`

  const email = (row.partner1_email ?? row.partner2_email ?? '').trim().toLowerCase()
  if (email) return `email:${email}`

  const name = [row.partner1_first_name, row.partner1_last_name]
    .filter(Boolean)
    .join(' ')
  const date = (row.inquiry_date ?? row.wedding_date ?? '').slice(0, 10)
  const named = slug(name)
  if (named) return `name:${named}:${date}`
  return `row:${date || 'undated'}`
}

/**
 * A key for one interaction within its row. The adapter's own per-row
 * identity when it has one (Calendly event uuid, HoneyBook event id);
 * otherwise type, direction and time, with the position as the tiebreak
 * for two identical interactions on one row. The parse is deterministic
 * over the same file, so the position is stable across uploads.
 */
export function interactionKeyFor(
  i: NormalisedInteractionRow,
  index: number,
): string {
  const external = (i.external_id ?? '').trim()
  if (external) return `x:${slug(external)}`
  return `i${index}:${i.type}:${i.direction}:${(i.occurred_at ?? '').slice(0, 19)}`
}

// ---------------------------------------------------------------------------
// Building the signals for one row
// ---------------------------------------------------------------------------

/** One committed row plus everything the flush needs to link it. */
export interface PendingRowSignals {
  /** Legacy weddings.id the row committed to. Filtered against the
   *  surviving set at flush time, like the related-contacts queue. */
  weddingId: string
  /** Adapter's own row key, for the log line only. */
  rowSourceId: string | null
  /** Already in time order, earliest first. */
  signals: NormalizedSignal[]
}

export interface BuildRowSignalsArgs {
  row: NormalisedLeadRow
  crmSource: CrmSource
  /** Legacy wedding this row committed to. Carried on every signal so
   *  `linkSignal` takes the fast path onto the mirrored couple. */
  weddingId: string
  /** The interactions that actually reached the spine: dedup said new or
   *  changed AND the processed marker was written. Anything else produces
   *  no signal. */
  interactions: NormalisedInteractionRow[]
  /** Merged, normalised handles for the row (`handlesFromRow`). */
  handles: NormalizedSignal['handles']
  /** Earliest real-world time the row carries (`firstSeenCandidateFor`).
   *  Empty string when the row has no usable date. */
  rowOccurredAt: string
  /** Channel-specific signals the caller built elsewhere, folded into the
   *  same time-ordered list. Today that is only HoneyBook's synthetic
   *  attribution row, which carries the "how did you hear" provenance and
   *  has its own external_id shape. */
  extraSignals?: NormalizedSignal[]
}

function identityFieldsFor(row: NormalisedLeadRow): Partial<NormalizedSignal> {
  const primaryName =
    [row.partner1_first_name, row.partner1_last_name].filter(Boolean).join(' ')
    || null
  const partnerName =
    [row.partner2_first_name, row.partner2_last_name].filter(Boolean).join(' ')
    || null
  return {
    identity_hint: primaryName ?? row.partner1_email ?? row.partner1_phone ?? null,
    primary_name: primaryName,
    primary_email: row.partner1_email ?? null,
    primary_phone: row.partner1_phone ?? null,
    partner_name: partnerName,
    partner_email: row.partner2_email ?? null,
    partner_phone: row.partner2_phone ?? null,
    wedding_date: row.wedding_date ?? null,
    session_ip: null,
    session_fingerprint: null,
  }
}

/**
 * One row's signals, earliest first.
 *
 * The row anchor always exists, even for a row with no interactions at
 * all, because the row itself IS an observation: the venue's CRM says
 * this couple was here on this date. It carries the row's handles and the
 * row's earliest date, which is what moves `first_seen_at` back.
 */
export function buildRowSignals(args: BuildRowSignalsArgs): NormalizedSignal[] {
  const {
    row, crmSource, weddingId, interactions, handles, rowOccurredAt,
  } = args
  const channel = channelForCrmSource(crmSource)
  const rowKey = rowKeyFor(row)
  const identity = identityFieldsFor(row)
  const isBooked = row.status === 'booked' || row.status === 'completed'

  const anchorOccurredAt =
    rowOccurredAt
    || row.inquiry_date
    || row.booked_at
    || new Date().toISOString()

  const signals: NormalizedSignal[] = [
    {
      ...identity,
      external_id: `crm_import:${crmSource}:${rowKey}:row`,
      channel,
      action_type: actionTypeForStatus(row.status),
      occurred_at: anchorOccurredAt,
      signal_tier: isBooked ? 'high' : 'medium',
      handles: handles ?? null,
      raw_payload: {
        provider: crmSource,
        kind: 'crm_import_row',
        source_id: row.source_id ?? null,
        status: row.status ?? null,
        inquiry_date: row.inquiry_date ?? null,
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
        source_detail: row.source_detail ?? null,
        guest_count_estimate: row.guest_count_estimate ?? null,
      },
      legacy_wedding_id: weddingId,
    } as NormalizedSignal,
  ]

  interactions.forEach((i, index) => {
    const occurredAt = i.occurred_at
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return
    signals.push({
      ...identity,
      external_id:
        `crm_import:${crmSource}:${rowKey}:${interactionKeyFor(i, index)}`,
      channel,
      action_type: actionTypeForInteraction(i),
      occurred_at: occurredAt,
      signal_tier: 'medium',
      handles: null,
      raw_payload: {
        provider: crmSource,
        kind: 'crm_import_interaction',
        source_id: row.source_id ?? null,
        interaction_type: i.type,
        direction: i.direction,
        subject: i.subject ?? null,
        signal_class: i.signal_class ?? null,
        surface: i.surface ?? null,
        extracted_identity: i.extracted_identity ?? null,
      },
      legacy_wedding_id: weddingId,
    } as NormalizedSignal)
  })

  for (const extra of args.extraSignals ?? []) {
    if (Number.isFinite(Date.parse(extra.occurred_at))) signals.push(extra)
  }

  // Time order. `first_seen_at` only ever moves earlier and point zero is
  // set once, so the order the couple sees its own history in matters.
  return signals.sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
  )
}

// ---------------------------------------------------------------------------
// Spine pre-check: does a couple already hold this row's identity?
// ---------------------------------------------------------------------------

/**
 * The legacy wedding of a couple that already holds this row's email or
 * phone. Read-only, deterministic anchors only, no judge.
 *
 * This is the half of cascade-first thinking that mint-first can keep. An
 * import row whose couple the spine already knows should land on that
 * couple rather than minting a second one beside it. A couple that has no
 * legacy wedding yet returns null and the row mints its own: promoting a
 * channel-scoped couple from here would be a spine write, and this file
 * does not write the spine.
 *
 * Never throws. On any failure the caller falls through to the legacy
 * resolver, which is where it was before.
 */
export async function findSpineCoupleWedding(args: {
  supabase: SupabaseClient
  venueId: string
  email: string | null
  phone: string | null
}): Promise<string | null> {
  const { supabase, venueId, email, phone } = args

  // `couples.primary_contact_email` is written verbatim by the mirror, so
  // the stored value keeps whatever case the CRM used. Try the row's own
  // spelling and its lower-case form rather than assuming either.
  const rawEmail = (email ?? '').trim()
  const attempts: Array<[string, string]> = []
  if (rawEmail) {
    attempts.push(['primary_contact_email', rawEmail])
    const lower = rawEmail.toLowerCase()
    if (lower !== rawEmail) attempts.push(['primary_contact_email', lower])
  }
  const rawPhone = (phone ?? '').trim()
  if (rawPhone) attempts.push(['primary_contact_phone', rawPhone])
  if (attempts.length === 0) return null

  try {
    for (const [column, value] of attempts) {
      const { data } = await supabase
        .from('couples')
        .select('id, source_wedding_id')
        .eq('venue_id', venueId)
        .eq(column, value)
        .is('merged_into_id', null)
        .limit(1)
        .maybeSingle()
      const weddingId = (data as { source_wedding_id?: string | null } | null)
        ?.source_wedding_id ?? null
      if (weddingId) return weddingId
    }
  } catch {
    // Read-only pre-check. A failure means we learned nothing, not that
    // anything is wrong; the legacy resolver runs next either way.
  }
  return null
}

// ---------------------------------------------------------------------------
// The flush
// ---------------------------------------------------------------------------

/**
 * The couples row mirroring one wedding, waiting for the mirror when it
 * has not landed yet.
 *
 * `mintWedding` fires `mirrorCoupleFromWedding` without awaiting it, so a
 * read straight after the mint can miss. This reads first, because by
 * flush time the fire-and-forget mirror has almost always arrived, and
 * only mirrors again when it has not. The mirror is the same idempotent
 * upsert on `(venue_id, source_wedding_id)`, so repeating it cannot
 * produce a second couple.
 */
export async function ensureMirroredCouple(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .maybeSingle()
  const existing = (data as { id?: string } | null)?.id ?? null
  if (existing) return existing

  const { mirrorCoupleFromWedding } = await import(
    '@/lib/services/identity/mirror-couple'
  )
  const mirrored = await mirrorCoupleFromWedding({ venueId, weddingId, supabase })
  return mirrored.coupleId
}

export interface RowSignalsSummary {
  /** Signals handed to the one writer. */
  sent: number
  /** Touchpoints attached to the row's couple. */
  attached: number
  /** Signals the cascade had already seen (a re-upload). */
  duplicate: number
  /** Couples minted by the cascade, i.e. the mirror had not landed and
   *  the fast path missed. Expected to be zero on a healthy import. */
  minted: number
  /** Platforms newly written to `couples.handles` by this import. */
  handlesRecorded: number
  /** Platforms where the row disagreed with a handle already held.
   *  Nothing was overwritten; each one is queued on `couple_merge_events`. */
  handleConflicts: number
  /** Rows skipped, and why. A dropped row is never a bare number. */
  skipped: Array<{ row: string; reason: string }>
}

/**
 * Hand every queued row's signals to the one writer, in time order.
 *
 * Runs after the row loop, like the related-contacts and handle flushes
 * before it, so a row whose wedding rolled back mid-import links nothing.
 *
 * Never throws. The legacy rows are already committed by the time this
 * runs, and a cascade failure must not fail an import that otherwise
 * worked. Every failure is counted and named in `skipped`.
 */
export async function commitRowSignals(args: {
  supabase: SupabaseClient
  venueId: string
  crmSource: CrmSource
  pending: PendingRowSignals[]
  /** Weddings that survived the row loop. Anything else rolled back. */
  survivingWeddings: Set<string>
}): Promise<RowSignalsSummary> {
  const { supabase, venueId, crmSource, pending, survivingWeddings } = args
  const summary: RowSignalsSummary = {
    sent: 0,
    attached: 0,
    duplicate: 0,
    minted: 0,
    handlesRecorded: 0,
    handleConflicts: 0,
    skipped: [],
  }
  if (pending.length === 0) return summary

  const { linkSignalWithLifecycle } = await import(
    '@/lib/services/identity/link-with-lifecycle'
  )
  const { newJudgeBudget } = await import('@/lib/services/identity/llm-judge')
  // Every signal here carries `legacy_wedding_id`, so the fast path takes
  // it and the judge is never reached. The budget is sized anyway, cheaply,
  // for the degraded case where a mirror failed and the cascade has to
  // score the row for real.
  const judgeBudget = newJudgeBudget(Math.min(pending.length, 200))

  for (const item of pending) {
    const label = item.rowSourceId ?? item.weddingId
    if (!survivingWeddings.has(item.weddingId)) {
      summary.skipped.push({ row: label, reason: 'wedding_row_rolled_back' })
      continue
    }

    // Wait for the mirror before the first signal goes out. Without this
    // the fast path misses and the cascade mints a second couple.
    let coupleId: string | null = null
    try {
      coupleId = await ensureMirroredCouple(supabase, venueId, item.weddingId)
    } catch (err) {
      summary.skipped.push({
        row: label,
        reason: 'mirror_failed: ' + (err instanceof Error ? err.message : 'unknown'),
      })
      continue
    }
    if (!coupleId) {
      summary.skipped.push({ row: label, reason: 'no_mirrored_couple' })
      continue
    }

    for (const signal of item.signals) {
      try {
        const result = await linkSignalWithLifecycle({
          supabase,
          venueId,
          signal,
          // adapter-source-justified: factual provenance label for linkSignal
          // telemetry (which importer produced the signal), not a
          // weddings.source attribution write.
          source: `crm_import:${crmSource}`,
          judgeBudget,
        })
        summary.sent += 1
        if (result.action === 'attached') summary.attached += 1
        if (result.action === 'duplicate') summary.duplicate += 1
        if (result.action === 'minted' || result.action === 'cold_start') {
          summary.minted += 1
        }
        const stamp = result.handle_stamp
        if (stamp) {
          summary.handlesRecorded += stamp.handlesAdded.length
          summary.handleConflicts += stamp.handleConflicts.length
        }
      } catch (err) {
        summary.skipped.push({
          row: label,
          reason:
            `link_failed:${signal.action_type}: `
            + (err instanceof Error ? err.message : 'unknown'),
        })
      }
    }
  }

  return summary
}
