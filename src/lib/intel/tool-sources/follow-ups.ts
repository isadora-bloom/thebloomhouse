/**
 * Tool source: follow-up state and follow-up proposals.
 *
 * W15 of NOVEMBER-PLAN.md wave 2. Battery Q34 ("find the 3 couples most
 * likely to book this month, draft a follow-up to each, explain why") and
 * Q37 ("find everyone I toured this weekend, draft follow-ups").
 *
 * BLOOM-TEST-QUESTIONS.md Tier 9 spells out the four links Q37 needs:
 * temporal cohort, a verification list the operator sees BEFORE anything
 * is written, a bulk draft on confirmation, and a state-aware no-op for
 * anyone already followed up. Links one and two already exist:
 * get_daily_list returns the tour cohort and the dispatcher resolves
 * their names. These two tools are links three and four, and they are
 * deliberately the read-only half of each:
 *
 *   get_follow_up_state  answers "have I already followed up with these
 *                        couples, and how" so the no-op is a fact rather
 *                        than a guess.
 *   propose_follow_ups   composes a personalised draft per couple and
 *                        hands the drafts back as PROPOSALS, alongside
 *                        the route the operator's confirmation would
 *                        call. It never touches the drafts table and
 *                        never sends.
 *
 * Why proposals and not drafts: types.ts, the plug-in contract, says a
 * source that must write returns the proposal and the id needed to act.
 * A model that can write on its own reading of a question is a model
 * that can email a couple by mistake, and that failure is unrecoverable
 * in a way a wrong number is not.
 *
 * Not entirely side-effect free, said out loud: composing still runs the
 * inquiry brain, which records its own cost row in `api_costs`. That write
 * is an audit of spend, not product state, and stays — every brain call
 * anywhere in the app writes one, and this tool's proposal capability needs
 * its cost recorded like any other call (matching W45 / NOVEMBER-PLAN wave
 * 6 decision). It used to also record an anti-repetition `phrase_usage`
 * row, but a read tool must not write a ledger (types.ts, the plug-in
 * contract), so NOVEMBER-PLAN.md wave 4 (W34) gave `selectPhrase` a
 * `record: false` option and this file passes it. No `drafts` row is
 * created, no email leaves, no `phrase_usage` row is written, and nothing
 * the operator would recognise as an action has happened.
 *
 * Spine first: identity, contact address and last inbound come from
 * `couples` and `touchpoints`. The suppression signals live in `drafts`,
 * `post_tour_sequence` and the operator's outbound history, which the
 * spine has no equivalent for, so those are read through the drafter's
 * own state loader keyed on `couples.source_wedding_id`.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntelToolSource, ToolSourceDeps } from './types'
import {
  loadFollowUpState,
  composeFollowUpDraft,
  FOLLOW_UP_SUPPRESS_DAYS,
  type FollowUpState,
} from '@/lib/services/cohort/bulk-follow-up'

export const TOOL_GET_FOLLOW_UP_STATE = 'get_follow_up_state'
export const TOOL_PROPOSE_FOLLOW_UPS = 'propose_follow_ups'

/** Most couples either tool will look at in one call. A weekend of tours
 *  is three or four couples; ten is a generous ceiling that still keeps a
 *  propose call to ten brain calls and a few seconds. Over the cap the
 *  answer says so rather than quietly dropping the tail. */
export const FOLLOW_UP_COUPLE_CAP = 10

/** Ceiling on the touchpoint sweep behind the last-inbound read. Ten
 *  couples with two hundred touchpoints each is already an outlier. */
const TOUCHPOINT_SCAN_LIMIT = 2000

/** The route an operator confirmation actually calls. Named here so the
 *  model can tell the operator what will happen next instead of implying
 *  it has already happened. */
export const FOLLOW_UP_SEND_ROUTE = {
  method: 'POST',
  path: '/api/agent/cohort',
  body: { action: 'draft', weddingIds: ['<weddingId of each couple you confirm>'] },
  note:
    'This is the confirm step of the existing cohort-action flow. It writes one pending draft per ' +
    'wedding id and still leaves the send behind a separate operator approval.',
} as const

/** How a prior follow-up reached the couple. */
export type FollowUpPath = 'sage_follow_up_draft' | 'post_tour_sequence' | 'operator_outbound'

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  primary_contact_email: string | null
  partner_contact_email: string | null
  lifecycle_state: string | null
  source_wedding_id: string | null
}

interface TouchpointRow {
  couple_id: string | null
  channel: string | null
  action_type: string | null
  direction: string | null
  occurred_at: string | null
}

/** Couple display name, primary then partner, mirroring the couples page. */
function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

/** Ids the model handed us, deduped, trimmed and capped. */
function readCoupleIds(args: Record<string, unknown>): {
  ids: string[]
  requested: number
  capped: boolean
} {
  const raw = args.couple_ids
  const list = Array.isArray(raw) ? raw : []
  const cleaned = [
    ...new Set(
      list
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  ]
  return {
    ids: cleaned.slice(0, FOLLOW_UP_COUPLE_CAP),
    requested: cleaned.length,
    capped: cleaned.length > FOLLOW_UP_COUPLE_CAP,
  }
}

/** Everything both tools need: the spine facts plus the drafter's state,
 *  joined on couples.source_wedding_id. */
interface CoupleContext {
  coupleId: string
  weddingId: string | null
  names: string | null
  lifecycle: string | null
  /** Reach-back address, spine first. */
  email: string | null
  emailSource: 'spine' | 'people_or_inbound' | null
  lastInbound: { at: string; channel: string | null; actionType: string | null } | null
  /** Why lastInbound is null when the couple does have touchpoints. */
  lastInboundNote: string | null
  daysSinceLastContact: number
  daysSinceLastContactSource: 'last_inbound_touchpoint' | 'no_inbound_on_record_defaulted_to_7'
  state: FollowUpState | null
}

async function loadCoupleContexts(
  supabase: SupabaseClient,
  venueId: string,
  coupleIds: string[],
  nowMs: number,
): Promise<{ contexts: CoupleContext[]; notFound: string[] }> {
  if (coupleIds.length === 0) return { contexts: [], notFound: [] }

  // Spine identity. merged_into_id IS NULL keeps tombstones out, the same
  // rule the canonical readers apply.
  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, partner_contact_name, primary_contact_email, partner_contact_email, lifecycle_state, source_wedding_id',
    )
    .eq('venue_id', venueId)
    .in('id', coupleIds)
    .is('merged_into_id', null)
  if (coupleErr) throw new Error(`follow-ups: couples ${coupleErr.message}`)
  const couples = (coupleData ?? []) as CoupleRow[]
  const byId = new Map(couples.map((c) => [c.id, c]))
  const notFound = coupleIds.filter((id) => !byId.has(id))

  // Last inbound from the spine. `direction` is stamped at write time by
  // the forwards-linker (migration 381) and read-time inference is banned,
  // so a touchpoint with no direction is reported as unknown rather than
  // guessed at from its action type.
  const lastInboundByCouple = new Map<string, TouchpointRow>()
  const anyTouchpointByCouple = new Map<string, TouchpointRow>()
  if (couples.length > 0) {
    const { data: tpData, error: tpErr } = await supabase
      .from('touchpoints')
      .select('couple_id, channel, action_type, direction, occurred_at')
      .eq('venue_id', venueId)
      .in('couple_id', couples.map((c) => c.id))
      .order('occurred_at', { ascending: false })
      .limit(TOUCHPOINT_SCAN_LIMIT)
    if (tpErr) throw new Error(`follow-ups: touchpoints ${tpErr.message}`)
    for (const t of (tpData ?? []) as TouchpointRow[]) {
      if (!t.couple_id || !byId.has(t.couple_id)) continue
      if (!anyTouchpointByCouple.has(t.couple_id)) anyTouchpointByCouple.set(t.couple_id, t)
      if (t.direction === 'inbound' && !lastInboundByCouple.has(t.couple_id)) {
        lastInboundByCouple.set(t.couple_id, t)
      }
    }
  }

  // Suppression signals, keyed on the wedding record the couple was
  // minted from. A couple with no source_wedding_id has no drafting
  // history to read and no id the confirm route would accept.
  const weddingIds = couples
    .map((c) => c.source_wedding_id)
    .filter((w): w is string => typeof w === 'string' && w.length > 0)
  const stateByWedding = await loadFollowUpState(supabase, venueId, weddingIds, nowMs)

  const contexts: CoupleContext[] = []
  for (const id of coupleIds) {
    const c = byId.get(id)
    if (!c) continue
    const state = c.source_wedding_id ? (stateByWedding.get(c.source_wedding_id) ?? null) : null

    const inbound = lastInboundByCouple.get(c.id) ?? null
    const hasTouchpoints = anyTouchpointByCouple.has(c.id)
    let lastInboundNote: string | null = null
    if (!inbound) {
      lastInboundNote = hasTouchpoints
        ? 'No touchpoint on this couple carries direction=inbound. Direction is stamped at write time (migration 381), so rows written before that migration read as unknown rather than being guessed at.'
        : 'No touchpoints on record for this couple.'
    }

    let daysSinceLastContact = 7
    let daysSinceLastContactSource: CoupleContext['daysSinceLastContactSource'] =
      'no_inbound_on_record_defaulted_to_7'
    if (inbound?.occurred_at) {
      const ms = Date.parse(inbound.occurred_at)
      if (Number.isFinite(ms)) {
        daysSinceLastContact = Math.max(1, Math.round((nowMs - ms) / 86_400_000))
        daysSinceLastContactSource = 'last_inbound_touchpoint'
      }
    }

    const spineEmail = c.primary_contact_email ?? c.partner_contact_email ?? null
    const email = spineEmail ?? state?.contactEmail ?? null
    const emailSource: CoupleContext['emailSource'] = spineEmail
      ? 'spine'
      : state?.contactEmail
        ? 'people_or_inbound'
        : null

    contexts.push({
      coupleId: c.id,
      weddingId: c.source_wedding_id,
      names: coupleNames(c.primary_contact_name, c.partner_contact_name),
      lifecycle: c.lifecycle_state,
      email,
      emailSource,
      lastInbound: inbound?.occurred_at
        ? {
            at: inbound.occurred_at,
            channel: inbound.channel,
            actionType: inbound.action_type,
          }
        : null,
      lastInboundNote,
      daysSinceLastContact,
      daysSinceLastContactSource,
      state,
    })
  }

  return { contexts, notFound }
}

/** What actually blocks a fresh follow-up for this couple.
 *
 *  Mostly the drafter's own verdict, with two adjustments. The drafter
 *  looks for a reach-back address in `people` and the inbound history;
 *  the spine may hold one it never sees, so a `no_contact_email` verdict
 *  is dropped when the couple record carries an address, and raised here
 *  when neither does. And a couple with no wedding record behind it has
 *  no drafting history to read at all, which is its own answer rather
 *  than a clean bill of health. */
function blockFor(ctx: CoupleContext): { reason: string; detail: string } | null {
  const label = ctx.names ?? 'this couple'
  if (!ctx.weddingId || !ctx.state) {
    return {
      reason: 'no_wedding_record',
      detail: `${label} has no wedding record behind them, so there is no drafting history to read and no id the confirm route would accept.`,
    }
  }
  // no_contact_email is the drafter's last check, so taking it over here
  // keeps the order the operator is shown reasons in.
  const s = ctx.state.suppression
  if (s && s.reason !== 'no_contact_email') return s
  if (!ctx.email) {
    return {
      reason: 'no_contact_email',
      detail: `No email on file for ${label}. Add a contact address before drafting a follow-up.`,
    }
  }
  return null
}

/** Which path a prior follow-up took, or null when there was none. */
function priorPath(state: FollowUpState | null): FollowUpPath | null {
  if (!state) return null
  if (state.lastFollowUpSentAt) return 'sage_follow_up_draft'
  if (state.sequenceNextStep) return 'post_tour_sequence'
  if (state.lastOperatorOutboundAt) return 'operator_outbound'
  return null
}

function nowMsFrom(deps: ToolSourceDeps): number {
  const parsed = Date.parse(deps.today)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function capNote(requested: number, used: number, capped: boolean): string | undefined {
  if (!capped) return undefined
  return `${requested} couple ids were supplied and only the first ${used} were handled. Ask again with the rest if you need them.`
}

// ---------------------------------------------------------------------------
// get_follow_up_state
// ---------------------------------------------------------------------------

const stateTool: Anthropic.Tool = {
  name: TOOL_GET_FOLLOW_UP_STATE,
  description:
    'For a list of couple ids, whether each one has ALREADY been followed up with, when, and by which ' +
    'path (a Sage follow-up draft that was sent, the post-tour email sequence, or the operator replying ' +
    'by hand); whether an automated sequence is still running and what it will send next; the last ' +
    'inbound message from the couple; and whether anything blocks a fresh follow-up (the couple opted ' +
    'out of AI drafting, the lead was written off, no contact address on file). ' +
    'Call this BEFORE proposing follow-ups so a couple who has already heard from you is skipped for a ' +
    'stated reason rather than emailed twice. Ids come from get_daily_list.',
  input_schema: {
    type: 'object',
    properties: {
      couple_ids: {
        type: 'array',
        items: { type: 'string' },
        description: `Couple ids (uuid) from get_daily_list. At most ${FOLLOW_UP_COUPLE_CAP} per call.`,
      },
    },
    required: ['couple_ids'],
    additionalProperties: false,
  },
}

async function runState(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const { ids, requested, capped } = readCoupleIds(args)
  if (ids.length === 0) {
    return {
      error:
        'couple_ids is required and must hold at least one couple id. Get ids from get_daily_list; there is no lookup by name.',
    }
  }
  const nowMs = nowMsFrom(deps)
  const { contexts, notFound } = await loadCoupleContexts(deps.supabase, venueId, ids, nowMs)

  const couples = contexts.map((ctx) => {
    const s = ctx.state
    const path = priorPath(s)
    const blockedBy = blockFor(ctx)
    return {
      coupleId: ctx.coupleId,
      names: ctx.names,
      lifecycle: ctx.lifecycle,
      weddingId: ctx.weddingId,
      followUpAlreadySent: path !== null,
      followUpPath: path,
      followUpSentAt:
        s?.lastFollowUpSentAt ?? s?.lastOperatorOutboundAt ?? null,
      sequenceRunning: Boolean(s?.sequenceNextStep),
      sequenceNextStep: s?.sequenceNextStep ?? null,
      lastInbound: ctx.lastInbound,
      lastInboundNote: ctx.lastInboundNote,
      clearToDraft: blockedBy === null,
      blockedBy,
      contactEmailOnFile: Boolean(ctx.email),
    }
  })

  return {
    requested,
    returned: couples.length,
    cap: FOLLOW_UP_COUPLE_CAP,
    capped,
    capNote: capNote(requested, ids.length, capped),
    suppressionWindowDays: FOLLOW_UP_SUPPRESS_DAYS,
    couples,
    notFound,
    checkedAgainst:
      'sent Sage follow-up drafts, the post-tour email sequence (migration 376), operator-authored ' +
      'outbound in the same window, and the couple inbound touchpoints on the spine',
  }
}

// ---------------------------------------------------------------------------
// propose_follow_ups
// ---------------------------------------------------------------------------

const proposeTool: Anthropic.Tool = {
  name: TOOL_PROPOSE_FOLLOW_UPS,
  description:
    'Compose a personalised follow-up email for each of the given couples and return the drafts as ' +
    'PROPOSALS. Each draft is written against that couple record and their recent touchpoints, not from ' +
    'a template. Couples who have already been followed up with are skipped with the reason. ' +
    'This writes nothing and sends nothing: the result carries the route the operator confirmation ' +
    'would call. Show the operator the list of couples and get their confirmation BEFORE calling this. ' +
    'Ids come from get_daily_list.',
  input_schema: {
    type: 'object',
    properties: {
      couple_ids: {
        type: 'array',
        items: { type: 'string' },
        description: `Couple ids (uuid) the operator has confirmed. At most ${FOLLOW_UP_COUPLE_CAP} per call.`,
      },
    },
    required: ['couple_ids'],
    additionalProperties: false,
  },
}

async function runPropose(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const { ids, requested, capped } = readCoupleIds(args)
  if (ids.length === 0) {
    return {
      error:
        'couple_ids is required and must hold at least one couple id. Get ids from get_daily_list; there is no lookup by name.',
    }
  }
  const nowMs = nowMsFrom(deps)
  const { contexts, notFound } = await loadCoupleContexts(deps.supabase, venueId, ids, nowMs)

  const proposals: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  const failed: Array<Record<string, unknown>> = []

  // Sequential on purpose. Each pass is a brain call, and a tight
  // Promise.all over a cohort would blow the per-venue rate limit, the
  // same reason the write path runs one at a time.
  for (const ctx of contexts) {
    const label = ctx.names ?? 'this couple'
    const blocked = blockFor(ctx)
    if (blocked) {
      skipped.push({
        coupleId: ctx.coupleId,
        weddingId: ctx.weddingId,
        names: ctx.names,
        reason: blocked.reason,
        detail: blocked.detail,
      })
      continue
    }
    // blockFor has already established both of these; the checks are here
    // so the types narrow rather than being asserted away.
    if (!ctx.weddingId || !ctx.email) continue

    try {
      const composed = await composeFollowUpDraft({
        venueId,
        weddingId: ctx.weddingId,
        contactEmail: ctx.email,
        daysSinceLastContact: ctx.daysSinceLastContact,
        // A read tool must not write a ledger (types.ts, the plug-in
        // contract). This is a PROPOSAL for the operator to look at, not a
        // follow-up that is being sent, so the brain's anti-repetition
        // phrase_usage row is skipped here. bulkDraftFollowUps (the write
        // path this tool hands the operator off to) still records one.
        recordPhraseUsage: false,
      })
      proposals.push({
        label,
        coupleId: ctx.coupleId,
        weddingId: ctx.weddingId,
        names: ctx.names,
        toEmail: ctx.email,
        emailSource: ctx.emailSource,
        subject: composed.subject,
        body: composed.body,
        confidence: composed.confidence,
        daysSinceLastContact: ctx.daysSinceLastContact,
        daysSinceLastContactSource: ctx.daysSinceLastContactSource,
        lastInbound: ctx.lastInbound,
      })
    } catch (err) {
      failed.push({
        coupleId: ctx.coupleId,
        weddingId: ctx.weddingId,
        names: ctx.names,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const draftedFor = proposals.map((p) => p.label as string)
  const skippedFor = skipped.map((s) => (s.names as string | null) ?? 'an unnamed couple')
  const summary =
    proposals.length === 0 && skipped.length === 0
      ? 'Nothing to propose.'
      : [
          proposals.length > 0 ? `Drafted for ${draftedFor.join(', ')}.` : 'Drafted nothing.',
          skipped.length > 0 ? `Skipped ${skippedFor.join(', ')}, reasons alongside.` : '',
        ]
          .filter(Boolean)
          .join(' ')

  return {
    requested,
    proposed: proposals.length,
    skipped: skipped.length,
    failed: failed.length,
    cap: FOLLOW_UP_COUPLE_CAP,
    capped,
    capNote: capNote(requested, ids.length, capped),
    writes: 'none',
    summary,
    proposals,
    skippedCouples: skipped,
    failedCouples: failed,
    notFound,
    confirmRoute: FOLLOW_UP_SEND_ROUTE,
    howToProceed:
      'Nothing has been saved. Show the operator each draft under the couple name, and if they want it ' +
      'sent, save it through the confirm route above, which writes a pending draft they then approve.',
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const followUpStateSource: IntelToolSource = {
  tool: stateTool,
  subjects: [
    'whether a couple has already been followed up with, and when',
    'which path a previous follow-up took (Sage draft, post-tour sequence, operator reply)',
    'whether an automated follow-up sequence is still running',
    'what blocks a fresh follow-up (AI opt-out, written-off lead, no contact address)',
  ],
  batteryQuestions: ['Q34', 'Q37'],
  run: runState,
}

export const proposeFollowUpsSource: IntelToolSource = {
  tool: proposeTool,
  subjects: [
    'drafting a personalised follow-up email for named couples',
    'bulk follow-up drafting after the operator confirms a list',
  ],
  batteryQuestions: ['Q34', 'Q37'],
  run: runPropose,
}

export const FOLLOW_UP_SOURCES: readonly IntelToolSource[] = [
  followUpStateSource,
  proposeFollowUpsSource,
]
