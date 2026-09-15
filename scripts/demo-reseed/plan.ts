/**
 * demo-reseed — turn a generated dataset into a plan.
 *
 * Pure. Reads no database, writes nothing, takes no clock. Given a
 * dataset it returns every delete and every replay step the applier would
 * perform, in the order it would perform them, so a test can assert on
 * the plan without a Supabase connection and the operator can read a dry
 * run before anything is touched.
 *
 * Ordering rule, from DEMO-RESEED-DESIGN.md §4: oldest first. `linkSignal`
 * mints on the FIRST signal it sees for a couple and matches every later
 * one against what it already knows, so replaying out of order would
 * scatter one couple across several spine rows.
 *
 * Ordering rule the design did not have, found by reading the code
 * (2026-09-09): `mintWedding` must come BEFORE the couple's first signal,
 * not after its tour. `mintWedding` fires `mirrorCoupleFromWedding`, which
 * UPSERTs `couples` on `(venue_id, source_wedding_id)`, and
 * `lockAndMintCouple` (the mint inside `linkSignal`) never sets
 * `source_wedding_id`. Mint the wedding first and pass its id as
 * `legacy_wedding_id` on every signal, and `linkSignal` takes its
 * legacy-wedding fast path and attaches every touchpoint to the one
 * couple the mirror made. Do it the other way round and each story ends
 * up with two couples rows: one from the linker, one from the mirror.
 */

import { calendlyToNormalizedSignal } from '../../src/lib/services/identity/calendly-to-signal'
import { emailToNormalizedSignal } from '../../src/lib/services/identity/email-to-signal'
import type { NormalizedSignal } from '../../src/lib/services/identity/sources/types'
import { AUX_TABLES, buildStoryAux, buildVenueAux, coupleRef } from './mirror-rows'
import { DEMO_VENUES, HERO_WEDDING_ID, tierForScore } from './roster'
import { WEDDING_STATUS_FOR_LIFECYCLE } from './generate'
import type {
  DeleteOp,
  DemoCoupleStory,
  DemoDataset,
  DemoLifecycle,
  DemoSignalStep,
  DemoTier,
  ReseedPlan,
  ReseedStep,
  ReseedStepKind,
} from './types'

const DAY_MS = 86_400_000

/**
 * Tables the reseed clears, child-first. Every one is venue-scoped, and
 * the applier refuses to touch any of them unless every target venue came
 * back with `is_demo = true`.
 *
 * `weddings` and `people` spare the couple-portal hero: deleting that
 * weddings row would cascade away the checklist, guest list, timeline and
 * seating rows that `supabase/seed.sql` and `seed-couple-portal.sql` key
 * to it, and the demo cookie resolves to that id in
 * `src/lib/api/auth-helpers.ts`.
 */
export const RESEED_DELETE_TABLES: ReadonlyArray<{ table: string; why: string }> = [
  // W70 mirror rows, child before parent. These used to be spared for the
  // hero wedding, on the reasoning that deleting the weddings row would
  // cascade them away. The reseed now REBUILDS them for every booking
  // including the hero, with dates measured from `today`, so sparing them
  // would leave last year's rehearsal dinner sitting under a heading that
  // says next week.
  { table: 'rsvp_responses', why: 'RSVP answers; rebuilt with the guest list' },
  { table: 'rsvp_config', why: 'RSVP form settings; one per booked wedding' },
  { table: 'guest_list', why: 'guests and their seats; rebuilt per booking' },
  { table: 'seating_tables', why: 'table map; rebuilt per booking' },
  { table: 'budget_payments', why: 'payments against budget lines' },
  { table: 'budget_items', why: 'the couple budget' },
  { table: 'contracts', why: 'generated and signed agreements' },
  { table: 'booked_vendors', why: 'suppliers on the day' },
  { table: 'wedding_party', why: 'the wedding party' },
  { table: 'commitment_reconciliation', why: 'the commitments queue' },
  { table: 'planning_notes', why: 'notes extracted from the couple thread' },
  { table: 'messages', why: 'couple-portal chat' },
  { table: 'event_feedback', why: 'post-event debrief on completed weddings' },
  { table: 'couple_invites', why: 'pending portal invitations' },
  { table: 'checklist_items', why: 'the planning checklist' },
  { table: 'timeline', why: 'the day timeline' },
  { table: 'drafts', why: 'the draft queue' },
  { table: 'lifecycle_transitions', why: 'stage history' },
  // Venue-level mirror rows the reseed also owns. Cleared for the same
  // reason as the rest: every date on them is measured from `today`.
  { table: 'marketing_spend_records', why: 'eighteen months of spend, re-dated' },
  { table: 'campaigns', why: 'campaign rollups behind the ROI page' },
  { table: 'reviews', why: 'reviews across four platforms, re-dated' },
  { table: 'review_language', why: 'phrase bank derived from those reviews' },
  { table: 'weather_alerts', why: 'one live alert, the rest expired' },
  { table: 'weather_climate_norms', why: 'decade-over-decade norms' },
  { table: 'weather_climate_annual', why: 'per-year monthly climate' },
  { table: 'follow_up_sequences', why: 'sequence definitions' },
  // NOT 'follow_up_sequence_templates' — migration 040 renamed it to
  // _archived_follow_up_sequence_templates. See mirror-rows.ts for the
  // full story; a delete against the old name fails with "not in the
  // schema cache" exactly like the aux insert did (W72).
  { table: 'packages', why: 'package, upgrade and discount catalogue' },
  { table: 'storefront', why: 'couple-facing picks' },
  { table: 'portal_section_config', why: 'which portal sections show' },
  { table: 'venue_resources', why: 'couple-facing links' },
  { table: 'brand_assets', why: 'logos and photography' },
  { table: 'accommodations', why: 'where guests stay' },
  { table: 'voice_training_sessions', why: 'voice-game history' },
  { table: 'brain_dump_entries', why: 'the brain-dump inbox' },
  { table: 'wedding_config', why: 'per-wedding budget settings' },
  { table: 'wedding_details', why: 'the details sheet' },
  { table: 'staffing_assignments', why: 'who is on shift' },
  { table: 'shuttle_schedule', why: 'shuttle runs' },
  { table: 'sage_conversations', why: 'portal chat history' },
  { table: 'ai_briefings', why: 'weekly and monthly briefings' },
  { table: 'anomaly_alerts', why: 'the anomaly feed' },
  { table: 'learned_preferences', why: 'what the voice loop has learned' },
  { table: 'natural_language_queries', why: 'ask-your-data history' },
  { table: 'phrase_usage', why: 'phrase bank usage' },
  { table: 'trend_recommendations', why: 'recommendations queue' },
  { table: 'email_sync_state', why: 'the mailbox cursor' },
  { table: 'draft_feedback', why: 'what the coordinator did with a draft' },
  { table: 'intelligence_extractions', why: 'what the extractor pulled out' },
  { table: 'inspo_gallery', why: 'the couple inspiration board' },
  { table: 'engagement_events', why: 'heat inputs; rewritten with fresh occurred_at' },
  { table: 'touchpoints', why: 'spine event log; rebuilt through linkSignal' },
  { table: 'fragments', why: 'unanchored signals from the old seed' },
  { table: 'candidate_matches', why: 'review queue entries for couples about to go' },
  { table: 'candidate_identities', why: 'Phase B contribution to the heat view' },
  { table: 'tangential_signals', why: 'pre-zero signals bound to old couples' },
  { table: 'interactions', why: 'legacy message log' },
  { table: 'wedding_touchpoints', why: 'legacy funnel table read by source comparison' },
  { table: 'tours', why: 'tour rows behind the daily lists' },
  { table: 'lost_deals', why: 'lost-deal rows behind the lost-deal reads' },
  { table: 'couples', why: 'the spine itself; rebuilt by the mirror + linkSignal' },
  { table: 'people', why: 'legacy contacts; rebuilt by mintWedding' },
  { table: 'weddings', why: 'legacy leads; rebuilt by mintWedding' },
]

/** Sort rank so a story's mint lands before its first signal when both
 *  carry the same instant. */
const KIND_RANK: Record<ReseedStepKind, number> = {
  // A story has either a mint (generated) or a contact sync (the pinned
  // hero), never both, and either has to land before the mirror reads
  // the people rows it derives the couple's identity from.
  mint_wedding: 0,
  hero_contact_sync: 1,
  mirror_couple: 2,
  link_signal: 3,
  heat_events: 4,
  tour_row: 5,
  lost_deal_row: 6,
  wedding_state: 7,
  // Last: mirror rows hang off a wedding that must already exist, and
  // their own order is carried by a per-millisecond nudge on occurredAt
  // rather than by this rank, because they are ordered among themselves.
  aux_rows: 8,
}

// ---------------------------------------------------------------------------
// Clock arithmetic. The only place offsets become instants.
// ---------------------------------------------------------------------------

/** UTC midnight of `today`, shifted back `daysAgo` days, plus
 *  `minuteOfDay` minutes. Negative `daysAgo` lands in the future. */
export function offsetIso(today: string, daysAgo: number, minuteOfDay = 0): string {
  const base = new Date(today)
  const midnight = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
  )
  return new Date(midnight - Math.floor(daysAgo) * DAY_MS + minuteOfDay * 60_000).toISOString()
}

/** yyyy-mm-dd for a `date` column. */
export function offsetDate(today: string, daysAgo: number): string {
  return offsetIso(today, daysAgo).slice(0, 10)
}

// ---------------------------------------------------------------------------
// Signal construction. Everything routes through a real adapter so the
// reseed produces the same shape live ingestion does.
// ---------------------------------------------------------------------------

/** Relay channels never carry the prospect's address in the From header,
 *  so the reseed leaves `rawFromEmail` null and supplies the identity
 *  through the resolved fields — the same discipline
 *  `scripts/reprocess-knot-orphan-inquiries.ts` applies. The matcher must
 *  never be handed a relay address as if it were a person. */
const RELAY_CHANNELS = new Set(['knot', 'weddingwire', 'instagram', 'website'])

export function externalIdFor(story: DemoCoupleStory, index: number): string {
  return `demo-reseed:${story.key}:${index}`
}

export function buildSignal(
  story: DemoCoupleStory,
  step: DemoSignalStep,
  index: number,
  occurredAt: string,
  weddingId: string,
  today: string,
): NormalizedSignal {
  const externalId = externalIdFor(story, index)
  const weddingDate =
    story.weddingDateOffsetDays === null
      ? null
      : offsetDate(today, story.weddingDateOffsetDays)

  if (step.channel === 'calendly') {
    const signal = calendlyToNormalizedSignal({
      event: step.actionType === 'tour_attended' ? 'attended_derived' : 'invitee_created',
      payload: {
        uri: externalId,
        email: story.primaryEmail,
        name: story.primaryName,
        scheduled_event: {
          uri: `${externalId}:event`,
          start_time: occurredAt,
        },
        questions_and_answers: story.partnerEmail
          ? [
              { question: 'Partner email', answer: story.partnerEmail },
              { question: 'Partner name', answer: story.partnerName ?? '' },
            ]
          : [],
      },
      weddingId,
      bookingExternalId: externalId,
    })
    return {
      ...signal,
      external_id: externalId,
      occurred_at: occurredAt,
      signal_tier: step.signalTier,
      action_type: step.actionType,
      partner_name: story.partnerName,
      partner_email: story.partnerEmail,
      wedding_date: weddingDate,
      legacy_wedding_id: weddingId,
      raw_payload: {
        ...signal.raw_payload,
        demo_reseed: true,
        body_text: step.bodyText,
      },
    }
  }

  const isRelay = RELAY_CHANNELS.has(step.channel)
  const base = emailToNormalizedSignal({
    email: {
      messageId: externalId,
      threadId: `demo-reseed:${story.key}`,
      subject:
        step.direction === 'inbound'
          ? `${story.primaryName} — ${step.actionType.replace(/_/g, ' ')}`
          : `Re: ${story.primaryName}`,
    },
    interactionId: externalId,
    emailDate: occurredAt,
    rawFromName: isRelay || step.direction === 'outbound' ? null : story.primaryName,
    rawFromEmail: isRelay || step.direction === 'outbound' ? null : story.primaryEmail,
    weddingId,
    signalTier: step.signalTier,
    resolvedEmail: story.primaryEmail,
    resolvedName: story.primaryName,
    resolvedPhone: story.primaryPhone,
    channelOverride: step.channel,
    actionTypeOverride: step.actionType,
    fullBody: step.bodyText,
  })

  return {
    ...base,
    partner_name: story.partnerName,
    partner_email: story.partnerEmail,
    wedding_date: weddingDate,
    author_class: step.direction === 'inbound' ? 'couple' : 'operator',
    // Migration 398: a handle is a first-class identifier, and the
    // linker is the only writer of `couples.handles`. Carrying it on the
    // signal is how a real Instagram DM arrives, so the demo gets the
    // handle column populated by the same route rather than by a seed
    // UPDATE that would prove nothing.
    handles:
      step.channel === 'instagram' && story.instagramHandle
        ? { instagram: story.instagramHandle }
        : undefined,
    raw_payload: {
      ...base.raw_payload,
      demo_reseed: true,
      direction: step.direction,
    },
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The lifecycle columns on the legacy `weddings` row. An UPDATE, not a
 * creation, so it sits outside the cascade's creation boundary.
 *
 * Deliberately absent: `heat_score` and `temperature_tier`. Migration 316
 * DROPPED both columns and replaced them with the `wedding_heat` view.
 * Heat now comes only from the `engagement_events` rows the applier
 * writes with the story's own `occurred_at`. Adding either column back
 * here would fail the update, and if it somehow did not, it would
 * reintroduce exactly the drift 316 was written to kill.
 */
function weddingPatchFor(story: DemoCoupleStory, today: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    status: WEDDING_STATUS_FOR_LIFECYCLE[story.lifecycle],
    source: story.weddingSource,
    guest_count_estimate: story.guestCount,
    booking_value: story.bookingValue,
    inquiry_date: offsetIso(today, story.inquiryDaysAgo, 9 * 60),
    first_response_at: offsetIso(
      today,
      Math.max(0, story.inquiryDaysAgo - story.responseDelayHours / 24),
      11 * 60,
    ),
    wedding_date:
      story.weddingDateOffsetDays === null
        ? null
        : offsetDate(today, story.weddingDateOffsetDays),
    tour_date: story.tourDaysAgo === null ? null : offsetIso(today, story.tourDaysAgo, 14 * 60),
    updated_at: today,
  }

  if (story.lifecycle === 'booked' || story.lifecycle === 'completed') {
    const signed = story.steps.find((s) => s.heatEvents.includes('contract_signed'))
    patch.booked_at = offsetIso(today, signed ? signed.daysAgo : story.inquiryDaysAgo, 15 * 60)
  }
  if (story.lifecycle === 'lost') {
    const lostStep = story.steps.find((s) => s.heatEvents.includes('not_interested_signal'))
    patch.lost_at = offsetIso(today, lostStep ? lostStep.daysAgo : story.inquiryDaysAgo, 15 * 60)
    patch.lost_reason = story.lostReason
  }
  return patch
}

export function buildReseedPlan(dataset: DemoDataset): ReseedPlan {
  const { today } = dataset
  const venueIds = dataset.venueIds.slice()
  const knownVenues = new Set(DEMO_VENUES.map((v) => v.id))
  for (const id of venueIds) {
    if (!knownVenues.has(id)) {
      throw new Error(
        `demo-reseed: ${id} is not one of the four Crestwood demo venues. ` +
          `Refusing to plan a wipe against it.`,
      )
    }
  }

  const deletes: DeleteOp[] = RESEED_DELETE_TABLES.map(({ table, why }) => {
    const op: DeleteOp = { table, venueIds, why }
    if (table === 'weddings') op.keepIds = [HERO_WEDDING_ID]
    if (table === 'people') op.keepWeddingIds = [HERO_WEDDING_ID]
    return op
  })

  const steps: ReseedStep[] = []
  let signalCount = 0
  let heatEventCount = 0
  let auxRowCount = 0

  for (const [storyIndex, story] of dataset.stories.entries()) {
    // The hero's wedding row is preserved, so its id is known up front.
    // Every other story gets its id at run time from mintWedding; the
    // plan carries a placeholder the applier substitutes.
    const weddingId = story.pinnedWeddingId ?? `<minted:${story.key}>`

    // Anchor the mint one second before the story's EARLIEST instant, not
    // before its first step by days-ago. Time of day is randomised per
    // step, so "one day older" is not always "earlier in the clock", and
    // a signal that sorts ahead of its own mint would find no wedding to
    // attach to.
    const stepInstants = story.steps.map((s) => offsetIso(today, s.daysAgo, s.minuteOfDay))
    const earliestMs = Math.min(...stepInstants.map((i) => new Date(i).getTime()))
    const latestMs = Math.max(...stepInstants.map((i) => new Date(i).getTime()))
    const firstAt = new Date(earliestMs - 1000).toISOString()
    // The state update settles the row after every signal has landed, and
    // after `today` so a signal timed later in the current day cannot
    // sort past it.
    const settleAt = new Date(
      Math.max(latestMs, new Date(today).getTime()) + 1000,
    ).toISOString()

    if (!story.hero) {
      steps.push({
        kind: 'mint_wedding',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt: firstAt,
      })
    } else {
      // The hero keeps its row. Sync the contact details so the spine and
      // the preserved people rows agree on one fictional address rather
      // than the seed's gmail one.
      steps.push({
        kind: 'hero_contact_sync',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt: firstAt,
        row: {
          wedding_id: HERO_WEDDING_ID,
          primary_email: story.primaryEmail,
          partner_email: story.partnerEmail,
          primary_phone: story.primaryPhone,
        },
      })
    }

    // Mirror explicitly. mintWedding fires the mirror fire-and-forget
    // (`void (async () => ...)`), so awaiting mintWedding does NOT
    // guarantee the couples row exists yet. Without this step the very
    // next linkSignal call would miss the legacy fast path and mint a
    // second couple.
    steps.push({
      kind: 'mirror_couple',
      storyKey: story.key,
      venueId: story.venueId,
      occurredAt: firstAt,
    })

    story.steps.forEach((s, index) => {
      const occurredAt = stepInstants[index]
      steps.push({
        kind: 'link_signal',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt,
        signal: buildSignal(story, s, index, occurredAt, weddingId, today),
      })
      signalCount++

      if (s.heatEvents.length > 0) {
        steps.push({
          kind: 'heat_events',
          storyKey: story.key,
          venueId: story.venueId,
          occurredAt,
          heatEvents: s.heatEvents.slice(),
          heatDirection: s.direction,
        })
        heatEventCount += s.heatEvents.length
      }
    })

    // Bookkeeping rows sort inside the story's own window. Their real
    // dates live in the row payload; `occurredAt` here is only a sort
    // key, and a future tour must not sort past the state update.
    const clampToWindow = (iso: string): string =>
      new Date(Math.min(new Date(iso).getTime(), latestMs)).toISOString()

    if (story.tourDaysAgo !== null) {
      steps.push({
        kind: 'tour_row',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt: clampToWindow(offsetIso(today, Math.max(0, story.tourDaysAgo), 14 * 60)),
        row: {
          venue_id: story.venueId,
          scheduled_at: offsetIso(today, story.tourDaysAgo, 14 * 60),
          tour_type: 'in_person',
          source: story.weddingSource,
          // A future tour has no outcome yet.
          outcome: story.tourDaysAgo < 0 ? null : story.tourOutcome,
          notes: `Demo reseed — ${story.primaryName}`,
          signal_class: 'touchpoint',
        },
      })
    }

    if (story.lifecycle === 'lost') {
      const lostStep = story.steps.find((s) => s.heatEvents.includes('not_interested_signal'))
      const lostDaysAgo = lostStep ? lostStep.daysAgo : story.inquiryDaysAgo
      steps.push({
        kind: 'lost_deal_row',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt: clampToWindow(offsetIso(today, lostDaysAgo, 16 * 60)),
        row: {
          venue_id: story.venueId,
          lost_at_stage: story.lostStage,
          reason_category: 'other',
          reason_detail: story.lostReason,
          lost_at: offsetIso(today, lostDaysAgo, 16 * 60),
          signal_class: 'outcome',
        },
      })
    }

    steps.push({
      kind: 'wedding_state',
      storyKey: story.key,
      venueId: story.venueId,
      occurredAt: settleAt,
      weddingPatch: weddingPatchFor(story, today),
    })

    // Mirror rows last, and in the order `buildStoryAux` returns them: a
    // budget payment cannot precede its budget line. The sort below is
    // stable, but leaning on that would be a silent dependency, so each
    // bundle gets its own instant a millisecond apart.
    const settleMs = new Date(settleAt).getTime()
    buildStoryAux(story, today, dataset.seed, storyIndex).forEach((bundle, i) => {
      steps.push({
        kind: 'aux_rows',
        storyKey: story.key,
        venueId: story.venueId,
        occurredAt: new Date(settleMs + 1 + i).toISOString(),
        table: bundle.table,
        rows: bundle.rows,
      })
      auxRowCount += bundle.rows.length
    })
  }

  // Venue-level mirror rows: the fragments that never resolved and the
  // candidate-match queue. They go after every story so the couple ids
  // they reference are already minted. Anchored to the venue's first
  // story because the applier walks steps by story.
  for (const venueId of venueIds) {
    const venueStories = dataset.stories.filter((s) => s.venueId === venueId)
    if (venueStories.length === 0) continue
    const anchor = venueStories[0]
    const tail = new Date(
      Math.max(...steps.map((s) => new Date(s.occurredAt).getTime())) + 1000,
    ).getTime()
    buildVenueAux(
      venueId,
      today,
      dataset.seed,
      venueStories.map((s) => coupleRef(s.key)),
    ).forEach((bundle, i) => {
      steps.push({
        kind: 'aux_rows',
        storyKey: anchor.key,
        venueId,
        occurredAt: new Date(tail + i).toISOString(),
        table: bundle.table,
        rows: bundle.rows,
      })
      auxRowCount += bundle.rows.length
    })
  }

  steps.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind]
    return a.storyKey < b.storyKey ? -1 : a.storyKey > b.storyKey ? 1 : 0
  })

  const byVenue: Record<string, number> = {}
  const byLifecycle = {
    inquiry: 0,
    tour_booked: 0,
    toured: 0,
    booked: 0,
    lost: 0,
    completed: 0,
  } as Record<DemoLifecycle, number>
  const byExpectedTier = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 } as Record<
    DemoTier,
    number
  >
  for (const story of dataset.stories) {
    byVenue[story.venueId] = (byVenue[story.venueId] ?? 0) + 1
    byLifecycle[story.lifecycle]++
    byExpectedTier[tierForScore(story.expectedHeat)]++
  }

  return {
    seed: dataset.seed,
    today,
    venueIds,
    preserveWeddingIds: [HERO_WEDDING_ID],
    deletes,
    steps,
    summary: {
      stories: dataset.stories.length,
      signals: signalCount,
      heatEvents: heatEventCount,
      auxRows: auxRowCount,
      byVenue,
      byLifecycle,
      byExpectedTier,
    },
  }
}

// ---------------------------------------------------------------------------
// --only-aux — re-run the mirror rows on a database whose spine (weddings,
// people, couples, touchpoints) is already seeded, without the
// delete-and-rebuild the full plan does.
// ---------------------------------------------------------------------------

/** The delete ops a `--only-aux` run should perform: exactly the aux-owned
 *  tables, still venue-scoped. Never `couples`, `touchpoints`, `weddings`,
 *  `people`, `engagement_events`, `tours`, `lost_deals` or
 *  `lifecycle_transitions`'s siblings that hang off dedicated step kinds
 *  rather than `aux_rows` — those are the spine and the delete-and-rebuild
 *  this mode exists to skip. */
export function auxOnlyDeletes(plan: ReseedPlan): DeleteOp[] {
  return plan.deletes.filter((d) => AUX_TABLES.includes(d.table))
}

/** The steps a `--only-aux` run should replay: every `aux_rows` step, in
 *  the same order the full plan carries them. */
export function auxOnlySteps(plan: ReseedPlan): ReseedStep[] {
  return plan.steps.filter((s) => s.kind === 'aux_rows')
}
