/**
 * demo-reseed: the mirror rows that hang off a story.
 *
 * W70. The spine (couples, touchpoints, weddings, people, progression)
 * is minted through `linkSignal` and `mintWedding`, and nothing in this
 * file touches any of those four tables: the applier refuses an aux step
 * that names one. What lives here is everything a surface reads AFTER the
 * couple exists: the guest list, the seating plan, the timeline, the
 * budget, the contract, the commitments a coordinator has to reconcile,
 * the drafts sitting in the queue.
 *
 * Why here rather than in SQL: every date is an offset from the dataset's
 * `today`, so a demo reseeded in March reads as March. Hand-written SQL
 * freezes a calendar date and, six months later, the couple portal shows a
 * rehearsal dinner that happened last spring under a heading that says
 * "next week". That was finding 5 of the 2026-09-08 walk in a different
 * costume.
 *
 * Determinism: each story draws from its own RNG stream, seeded from the
 * dataset seed and the story key. Adding a story therefore does not
 * renumber every other story's guest list, which is what a single shared
 * stream would do and what makes a "same seed, same output" test useless
 * the first time someone changes the roster.
 *
 * Ids are generated, not left to the database. A second reseed must be
 * able to replace a guest list rather than lay a second one on top of it,
 * and a Playwright spec has to be able to hold an id.
 *
 * Filename note: this started life as `aux.ts`, which git on Windows
 * refuses to index, because AUX is a reserved device name and has been
 * since DOS. Node wrote the file happily and every `git add` failed with
 * "No such file or directory" on a file that was plainly there. Do not
 * rename it back.
 */

import { makeRng, uuidFrom, type Rng } from './rng'
import { DEMO_VENUES } from './roster'
import type { DemoCoupleStory, DemoDataset } from './types'

/**
 * Placeholders. A plan is built without a database, so the ids the run
 * will mint are not known yet; the applier swaps these for the real ones
 * before the insert. Story-keyed rather than bare, so a venue-level row
 * can point at a named couple.
 */
export function weddingRef(storyKey: string): string {
  return `<wedding:${storyKey}>`
}

export function coupleRef(storyKey: string): string {
  return `<couple:${storyKey}>`
}

export const WEDDING_REF_RE = /^<wedding:(.+)>$/
export const COUPLE_REF_RE = /^<couple:(.+)>$/

export interface AuxBundle {
  table: string
  rows: Array<Record<string, unknown>>
}

/**
 * Tables the aux path is forbidden from writing. One writer each,
 * enforced in `applyAuxRows` rather than trusted.
 */
export const AUX_FORBIDDEN_TABLES: readonly string[] = [
  'couples',
  'touchpoints',
  'weddings',
  'people',
  'couple_progression_events',
]

/**
 * Every table `buildStoryAux` and `buildVenueAux` can write, in the order
 * the applier must insert them: a child never precedes its parent.
 * `scripts/demo-coverage.ts` asserts the generated plan actually reaches
 * all of these.
 */
export const AUX_TABLES: readonly string[] = [
  'checklist_items',
  'timeline',
  'seating_tables',
  'guest_list',
  'rsvp_config',
  'rsvp_responses',
  'contracts',
  'budget_items',
  'budget_payments',
  'booked_vendors',
  'wedding_party',
  'planning_notes',
  'commitment_reconciliation',
  'messages',
  'event_feedback',
  'couple_invites',
  'drafts',
  'lifecycle_transitions',
  'candidate_matches',
  'fragments',
  // Venue-level, but still the reseed's to own: every one is dated
  // relative to `today`, which is the whole argument against writing
  // them as SQL.
  'marketing_spend_records',
  'campaigns',
  'reviews',
  'review_language',
  'weather_alerts',
  'weather_climate_norms',
  'weather_climate_annual',
  'follow_up_sequences',
  // NOT 'follow_up_sequence_templates'. Migration 009 created it;
  // migration 040 renamed it to _archived_follow_up_sequence_templates
  // when the sequence model was consolidated onto follow_up_sequences +
  // sequence_steps. It has not existed under this name since, so it is
  // phantom on production (W72 finding 1) — PostgREST answers "not in
  // the schema cache", which reads like a permissions error but is a
  // schema-drift one. `schema-facts.ts` + `validate-plan.ts` catch this
  // class generically now; this table is simply not written.
  'packages',
  'storefront',
  'portal_section_config',
  'venue_resources',
  'brand_assets',
  'accommodations',
  'voice_training_sessions',
  'brain_dump_entries',
  'table_map_layouts',
  'wedding_config',
  'wedding_details',
  'staffing_assignments',
  'shuttle_schedule',
  'sage_conversations',
  'ai_briefings',
  'anomaly_alerts',
  'learned_preferences',
  'natural_language_queries',
  'phrase_usage',
  'trend_recommendations',
  'email_sync_state',
  'draft_feedback',
  'intelligence_extractions',
  'inspo_gallery',
]

const DAY_MS = 86_400_000

function offsetIso(today: string, daysAgo: number, minuteOfDay = 0): string {
  const base = new Date(today)
  const midnight = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())
  return new Date(midnight - Math.floor(daysAgo) * DAY_MS + minuteOfDay * 60_000).toISOString()
}

function offsetDate(today: string, daysAgo: number): string {
  return offsetIso(today, daysAgo).slice(0, 10)
}

function slugifyLocal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** FNV-1a, so a story key becomes a stable 32-bit seed. */
export function seedFor(base: number, key: string): number {
  let h = 0x811c9dc5 ^ (base >>> 0)
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Word lists. Fictional, ordinary, and nothing that names a real venue,
// a real supplier or a real person. `check-no-hardcoded-sage.mjs` reads
// this file like any other.
// ---------------------------------------------------------------------------

const GUEST_FIRST: readonly string[] = [
  'Aoife', 'Bram', 'Calla', 'Dev', 'Elsie', 'Ferran', 'Greta', 'Hal',
  'Iris', 'Jonas', 'Kirin', 'Lore', 'Mabel', 'Nils', 'Ottilie', 'Piet',
  'Quill', 'Rosa', 'Sten', 'Tove', 'Ulla', 'Verity', 'Wynn', 'Xan',
]

const GUEST_LAST: readonly string[] = [
  'Abbott', 'Beckwith', 'Crane', 'Dunmore', 'Ellwood', 'Fenwick',
  'Garrick', 'Halloway', 'Inchbold', 'Jessop', 'Kerrigan', 'Lomax',
  'Mowbray', 'Netherby', 'Orme', 'Pemberton',
]

const GUEST_GROUPS: readonly string[] = [
  'Bride side',
  'Partner side',
  'University friends',
  'Work',
  'Neighbours',
  'Family friends',
]

const MEALS: readonly string[] = ['Chicken', 'Beef', 'Vegetarian', 'Fish', 'Vegan']

const DIETARY: readonly (string | null)[] = [
  null, null, null, 'Nut allergy', 'Gluten free', 'Dairy free', 'No shellfish',
]

const TIMELINE_EVENTS: ReadonlyArray<{ title: string; category: string; minute: number; mins: number }> = [
  { title: 'Suppliers arrive', category: 'setup', minute: 9 * 60, mins: 120 },
  { title: 'Hair and make-up in the cottage', category: 'prep', minute: 10 * 60, mins: 180 },
  { title: 'Guests arrive', category: 'ceremony', minute: 14 * 60, mins: 30 },
  { title: 'Ceremony', category: 'ceremony', minute: 14 * 60 + 30, mins: 35 },
  { title: 'Drinks on the lawn', category: 'reception', minute: 15 * 60 + 15, mins: 75 },
  { title: 'Group photographs', category: 'photos', minute: 16 * 60, mins: 40 },
  { title: 'Wedding breakfast', category: 'reception', minute: 17 * 60, mins: 105 },
  { title: 'Speeches', category: 'reception', minute: 18 * 60 + 45, mins: 40 },
  { title: 'Cake and first dance', category: 'reception', minute: 20 * 60, mins: 30 },
  { title: 'Carriages', category: 'close', minute: 23 * 60 + 30, mins: 30 },
]

const CHECKLIST: ReadonlyArray<{ title: string; category: string; dueBefore: number }> = [
  { title: 'Return the signed agreement', category: 'admin', dueBefore: 300 },
  { title: 'Confirm the final guest number', category: 'guests', dueBefore: 30 },
  { title: 'Send the supplier list', category: 'vendors', dueBefore: 60 },
  { title: 'Menu tasting', category: 'catering', dueBefore: 120 },
  { title: 'Decide the ceremony music', category: 'ceremony', dueBefore: 45 },
  { title: 'Seating plan to the venue', category: 'guests', dueBefore: 14 },
  { title: 'Final balance', category: 'admin', dueBefore: 21 },
  { title: 'Rehearsal walk-through', category: 'ceremony', dueBefore: 2 },
]

const BUDGET_LINES: ReadonlyArray<{ category: string; item: string; budgeted: number }> = [
  { category: 'Venue', item: 'Venue hire', budgeted: 8500 },
  { category: 'Catering', item: 'Wedding breakfast', budgeted: 6400 },
  { category: 'Catering', item: 'Evening food', budgeted: 1200 },
  { category: 'Flowers', item: 'Ceremony and tables', budgeted: 1850 },
  { category: 'Photography', item: 'Full-day coverage', budgeted: 2400 },
  { category: 'Music', item: 'Band and DJ', budgeted: 1700 },
  { category: 'Attire', item: 'Dress and suits', budgeted: 2600 },
  { category: 'Stationery', item: 'Invitations and signage', budgeted: 480 },
]

const VENDOR_TYPES: ReadonlyArray<{ type: string; name: string }> = [
  { type: 'photographer', name: 'Ashlight Studio' },
  { type: 'florist', name: 'Ninebark Flowers' },
  { type: 'caterer', name: 'Two Hares Catering' },
  { type: 'band', name: 'The Paper Lanterns' },
  { type: 'cake', name: 'Marlow Bakehouse' },
  { type: 'celebrant', name: 'Wren Ceremonies' },
  { type: 'transport', name: 'Halfpenny Cars' },
]

const PARTY_ROLES: ReadonlyArray<{ role: string; label: string }> = [
  { role: 'maid_of_honor', label: 'Maid of honour' },
  { role: 'best_man', label: 'Best man' },
  { role: 'bridesmaid', label: 'Bridesmaid' },
  { role: 'groomsman', label: 'Groomsman' },
  { role: 'flower_girl', label: 'Flower girl' },
  { role: 'ring_bearer', label: 'Ring bearer' },
]

const COMMITMENTS: ReadonlyArray<{ quote: string; kind: string; status: string }> = [
  {
    quote: 'My grandmother cannot manage the steps, so we will need her seated before anyone else comes in.',
    kind: 'special_request',
    status: 'unmatched',
  },
  {
    quote: 'We would like to do the speeches before the food rather than after.',
    kind: 'intention',
    status: 'matched',
  },
  {
    quote: 'Please do not play anything by the band my brother is in.',
    kind: 'planning_note',
    status: 'dismissed',
  },
  {
    quote: 'We want the dog in the group photographs, just for a few minutes.',
    kind: 'special_request',
    status: 'added',
  },
]

const PLANNING_NOTES: ReadonlyArray<{ category: string; content: string }> = [
  { category: 'vendor', content: 'Photographer confirmed, arriving at ten for the prep shots.' },
  { category: 'guest_count', content: 'Guest count moved from 110 to 124 after the second round of invitations.' },
  { category: 'decor', content: 'They want the long tables rather than the rounds, with greenery down the middle.' },
  { category: 'checklist', content: 'Still waiting on the final menu choices from three tables.' },
]

/**
 * Every state a draft can sit in that a coordinator would see on the
 * queue. `drafts_status_check` (migration 067) also allows 'rejected' and
 * 'auto_send_sending'; the first is a dead end and the second is a
 * millisecond-wide transient, so neither earns a row.
 */
export const DRAFT_STATES: readonly string[] = [
  'pending',
  'sent',
  'auto_send_pending',
  'auto_send_failed',
  'approved',
]

/**
 * What the extractor pulls out of a first email. Every one of these is a
 * field a real inquiry carries, so the extractions page shows the same
 * shape live ingestion produces.
 */
const EXTRACTIONS: ReadonlyArray<{
  type: string
  value: (s: DemoCoupleStory) => string
  confidence: number
}> = [
  { type: 'guest_count', value: (s) => String(s.guestCount), confidence: 0.94 },
  { type: 'preferred_season', value: () => 'late summer', confidence: 0.71 },
  { type: 'budget_signal', value: () => 'mentioned a ceiling without naming it', confidence: 0.58 },
  { type: 'decision_makers', value: () => 'both partners plus one parent', confidence: 0.66 },
  { type: 'hear_source', value: (s) => s.weddingSource, confidence: 0.88 },
  { type: 'accessibility_need', value: () => 'step-free route for one guest', confidence: 0.79 },
]

const DRAFT_BODIES: readonly string[] = [
  'Thank you for getting in touch. I have put a provisional hold on that Saturday for you and attached the brochure.',
  'Lovely to meet you both on Saturday. Here is the pricing we talked about, with the Friday rate at the bottom.',
  'Just checking in on this one. The date is still open, and I can hold it for another fortnight.',
  'Here is the revised quote with the extra hour and the rehearsal dinner added.',
  'The contract is attached. Nothing to print, the signature happens in the link.',
]

// ---------------------------------------------------------------------------
// Per-story rows
// ---------------------------------------------------------------------------

/** True when the couple is far enough along to have a portal at all. */
function hasPortal(story: DemoCoupleStory): boolean {
  return story.lifecycle === 'booked' || story.lifecycle === 'completed'
}

/** Days from `today` to the wedding, positive when it already happened. */
function weddingDaysAgo(story: DemoCoupleStory): number {
  return story.weddingDateOffsetDays ?? 120
}

function guestRows(
  story: DemoCoupleStory,
  rng: Rng,
  today: string,
  wRef: string,
): { guests: Array<Record<string, unknown>>; tables: Array<Record<string, unknown>> } {
  const tableCount = rng.int(4, 8)
  const tables = Array.from({ length: tableCount }, (_, i) => ({
    id: uuidFrom(rng),
    venue_id: story.venueId,
    wedding_id: wRef,
    table_name: i === 0 ? 'Top table' : `Table ${i}`,
    table_type: i === 0 ? 'head' : rng.chance(0.7) ? 'round' : 'rectangle',
    capacity: i === 0 ? 8 : rng.int(8, 12),
    x_position: 120 + (i % 3) * 180,
    y_position: 120 + Math.floor(i / 3) * 170,
    rotation: 0,
    sort_order: i,
    notes: i === 0 ? 'Keep the aisle side clear for the wheelchair.' : null,
  }))

  const guestCount = Math.min(story.guestCount, rng.int(14, 26))
  const guests = Array.from({ length: guestCount }, (_, i) => {
    const first = GUEST_FIRST[(i * 7 + tableCount) % GUEST_FIRST.length]
    const last = GUEST_LAST[(i * 5 + 3) % GUEST_LAST.length]
    const table = tables[i % tables.length]
    // Past weddings are fully answered. Future ones are mid-flight, which
    // is the state a coordinator actually looks at.
    const past = weddingDaysAgo(story) > 0
    const rsvp = past
      ? rng.chance(0.9)
        ? 'attending'
        : 'declined'
      : rng.pick(['pending', 'attending', 'attending', 'declined', 'maybe'])
    const responded = rsvp === 'pending' ? null : offsetIso(today, weddingDaysAgo(story) + rng.int(10, 60), 11 * 60)
    return {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.net`,
      group_name: GUEST_GROUPS[i % GUEST_GROUPS.length],
      rsvp_status: rsvp,
      meal_choice: rsvp === 'attending' ? rng.pick(MEALS) : null,
      dietary_restrictions: rng.pick(DIETARY),
      has_plus_one: rng.chance(0.3),
      plus_one_name: null,
      table_assignment_id: table.id,
      table_assignment: table.table_name,
      invitation_sent: true,
      rsvp_responded_at: responded,
      needs_accessibility: i === 0,
      accessibility_notes: i === 0 ? 'Step-free route to the ceremony room.' : null,
      staying_overnight: rng.chance(0.35),
      needs_shuttle: rng.chance(0.25),
    }
  })

  return { guests, tables }
}

/**
 * Everything one story contributes, in insert order.
 *
 * Exported so a test can drive it with a single story and assert on the
 * shape without building a whole dataset.
 */
export function buildStoryAux(
  story: DemoCoupleStory,
  today: string,
  seed: number,
  /** Position in the dataset. Used only where a state has to be
   *  guaranteed present rather than merely likely. */
  index = 0,
): AuxBundle[] {
  const rng = makeRng(seedFor(seed, story.key))
  const wRef = weddingRef(story.key)
  const out: AuxBundle[] = []
  const push = (table: string, rows: Array<Record<string, unknown>>): void => {
    if (rows.length > 0) out.push({ table, rows })
  }

  const venue = DEMO_VENUES.find((v) => v.id === story.venueId) ?? DEMO_VENUES[0]
  const wDays = weddingDaysAgo(story)
  const signed = story.steps.find((s) => s.heatEvents.includes('contract_signed'))
  const signedDaysAgo = signed ? signed.daysAgo : story.inquiryDaysAgo

  // -- Lifecycle transitions. Every story has at least one; the whole
  //    point of the stage machine is that a lead moved.
  const stages: string[] = ['inquiry']
  if (story.tourDaysAgo !== null) stages.push('tour_scheduled', 'tour_completed')
  if (story.lifecycle === 'booked' || story.lifecycle === 'completed') stages.push('booked')
  if (story.lifecycle === 'completed') stages.push('completed')
  if (story.lifecycle === 'lost') stages.push('lost')
  push(
    'lifecycle_transitions',
    stages.slice(1).map((to, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      from_stage: stages[i],
      to_stage: to,
      transition_kind: i === 0 ? 'deterministic' : rng.chance(0.7) ? 'deterministic' : 'llm_judged',
      evidence: { source: 'demo-reseed', story: story.key },
      reasoning:
        to === 'lost'
          ? (story.lostReason ?? 'No reply after three attempts.')
          : `Moved to ${to.replace(/_/g, ' ')} on the signal log.`,
      confidence: 0.9,
      transitioned_at: offsetIso(
        today,
        Math.max(0, story.inquiryDaysAgo - (i + 1) * 5),
        13 * 60,
      ),
    })),
  )

  // -- Drafts. One per story that is still live, across the four states
  //    a coordinator sees on the queue: waiting, sent, held for review,
  //    and the one that fell over.
  //    Cycled by position rather than picked at random: "every state" has
  //    to be a fact about the seed, not a thing that is very likely at 60
  //    couples and stops being true the day someone passes --couples=8.
  const draftState = DRAFT_STATES[index % DRAFT_STATES.length]
  const draftId = uuidFrom(rng)
  const draftBody = rng.pick(DRAFT_BODIES)
  push('drafts', [
    {
      id: draftId,
      venue_id: story.venueId,
      wedding_id: wRef,
      to_email: story.primaryEmail,
      subject: `Re: ${venue.name}, ${story.primaryName}`,
      draft_body: draftBody,
      status: draftState,
      context_type: hasPortal(story) ? 'client' : 'inquiry',
      confidence_score: rng.int(62, 96),
      model_used: 'demo-seeded',
      auto_sent: draftState === 'sent',
      sent_at: draftState === 'sent' ? offsetIso(today, Math.max(0, story.inquiryDaysAgo - 1), 10 * 60) : null,
      auto_send_attempts: draftState === 'auto_send_failed' ? 3 : 0,
      auto_send_last_error:
        draftState === 'auto_send_failed'
          ? 'Resend returned 422: the sending domain is not verified yet.'
          : null,
      created_at: offsetIso(today, Math.max(0, story.inquiryDaysAgo - 1), 9 * 60),
    },
  ])

  // -- What the coordinator did with that draft. `draft_feedback` is what
  //    the voice loop learns from, so a demo with three rows in it can
  //    show the page and prove nothing about the loop.
  if (draftState === 'sent' || draftState === 'approved') {
    push('draft_feedback', [
      {
        id: uuidFrom(rng),
        venue_id: story.venueId,
        draft_id: draftId,
        action: rng.chance(0.6) ? 'edited' : 'approved',
        original_body: draftBody,
        edited_body: `${draftBody} Let me know either way and I will hold it until Friday.`,
        coordinator_edits: 'Added the hold deadline, cut the second sentence.',
        created_at: offsetIso(today, Math.max(0, story.inquiryDaysAgo - 1), 10 * 60),
      },
    ])
  }

  push(
    'intelligence_extractions',
    EXTRACTIONS.map((e) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      extraction_type: e.type,
      value: e.value(story),
      confidence: e.confidence,
      created_at: offsetIso(today, Math.max(0, story.inquiryDaysAgo - 1), 12 * 60),
    })),
  )

  if (!hasPortal(story)) return out

  // -----------------------------------------------------------------------
  // From here on: a booked or completed couple, which is the only kind
  // with a portal, a guest list and a budget.
  // -----------------------------------------------------------------------

  push(
    'checklist_items',
    CHECKLIST.map((c, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      title: c.title,
      description: null,
      category: c.category,
      due_date: offsetDate(today, wDays + c.dueBefore),
      // Anything due before today on a wedding that has happened is done.
      is_completed: wDays + c.dueBefore > 0 ? rng.chance(0.8) : rng.chance(0.3),
      sort_order: i,
      assigned_to: i % 3 === 0 ? 'Coordinator' : null,
    })),
  )

  push(
    'timeline',
    TIMELINE_EVENTS.map((e, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      time: `${String(Math.floor(e.minute / 60)).padStart(2, '0')}:${String(e.minute % 60).padStart(2, '0')}:00`,
      duration_minutes: e.mins,
      title: e.title,
      description: null,
      category: e.category,
      location: i < 2 ? 'Cottage' : venue.name,
      sort_order: i,
    })),
  )

  const { guests, tables } = guestRows(story, rng, today, wRef)
  push('seating_tables', tables)
  push('guest_list', guests)

  push('rsvp_config', [
    {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      ask_meal_choice: true,
      ask_dietary: true,
      ask_allergies: true,
      ask_shuttle: true,
      ask_song_request: true,
      ask_message: true,
      allow_maybe: true,
      custom_questions: [{ label: 'Are you bringing a child?', type: 'boolean' }],
      rsvp_deadline: offsetDate(today, wDays + 45),
    },
  ])

  push(
    'rsvp_responses',
    guests
      .filter((g) => g.rsvp_status !== 'pending')
      .slice(0, 8)
      .map((g) => ({
        id: uuidFrom(rng),
        venue_id: story.venueId,
        wedding_id: wRef,
        guest_id: g.id,
        email: g.email,
        shuttle_needed: g.needs_shuttle,
        song_request: rng.pick([
          'Anything but the chicken dance.',
          'Something slow for my parents, please.',
          null,
        ]),
        message_to_couple: rng.pick([
          'We would not miss it.',
          'So pleased for you both.',
          null,
        ]),
        allergies: g.dietary_restrictions,
        responded_at: g.rsvp_responded_at,
      })),
  )

  // -- Contracts. The agreement every booking has uploaded, plus a revised
  //    one on about a third of them (guest count moved). Uploads only:
  //    contracts the venue sends come from ContractHouse since W57 was
  //    removed on 2026-09-17.
  const contracts: Array<Record<string, unknown>> = [
    {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      filename: `${venue.slug}-agreement.pdf`,
      file_type: 'pdf',
      storage_path: `${story.key}/agreement.pdf`,
      extracted_text: `Wedding agreement between ${story.primaryName} and ${venue.name}.`,
      kind: 'uploaded',
      status: 'extracted',
      created_at: offsetIso(today, signedDaysAgo + 4, 15 * 60),
    },
  ]
  if (rng.chance(0.35)) {
    contracts.push({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      filename: `${venue.slug}-agreement-revised.pdf`,
      file_type: 'pdf',
      storage_path: `${story.key}/agreement-revised.pdf`,
      extracted_text: 'Revised agreement after the guest count changed.',
      kind: 'uploaded',
      status: 'extracted',
      created_at: offsetIso(today, Math.max(1, wDays + 90), 11 * 60),
    })
  }
  push('contracts', contracts)

  const budgetRows = BUDGET_LINES.map((b, i) => {
    const budgeted = b.budgeted + rng.int(-4, 8) * 50
    const committed = rng.chance(0.8) ? budgeted : 0
    const paid = committed > 0 ? (wDays > 0 ? committed : Math.round(committed * rng.next())) : 0
    return {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      category: b.category,
      item_name: b.item,
      budgeted,
      committed,
      paid,
      vendor_name: i < VENDOR_TYPES.length ? VENDOR_TYPES[i].name : null,
      payment_due_date: offsetDate(today, wDays + 30),
      sort_order: i,
    }
  })
  push('budget_items', budgetRows)

  push(
    'budget_payments',
    budgetRows
      .filter((b) => (b.paid as number) > 0)
      .slice(0, 4)
      .map((b) => ({
        id: uuidFrom(rng),
        budget_item_id: b.id,
        venue_id: story.venueId,
        wedding_id: wRef,
        amount: Math.round((b.paid as number) / 2),
        payment_date: offsetDate(today, wDays + 60),
        payment_method: rng.pick(['bank transfer', 'card', 'cheque']),
        notes: 'Deposit',
      })),
  )

  push(
    'booked_vendors',
    rng.shuffle(VENDOR_TYPES).slice(0, rng.int(4, 6)).map((v) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      vendor_type: v.type,
      vendor_name: v.name,
      contact_name: `${GUEST_FIRST[rng.int(0, GUEST_FIRST.length - 1)]} ${GUEST_LAST[rng.int(0, GUEST_LAST.length - 1)]}`,
      contact_email: `hello@${v.name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`,
      is_booked: true,
      arrival_time: '10:00',
      departure_time: '23:30',
      worked_here_before: rng.chance(0.5),
    })),
  )

  push(
    'wedding_party',
    rng.shuffle(PARTY_ROLES).slice(0, rng.int(4, 6)).map((p) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      name: `${GUEST_FIRST[rng.int(0, GUEST_FIRST.length - 1)]} ${GUEST_LAST[rng.int(0, GUEST_LAST.length - 1)]}`,
      role: p.role,
    })),
  )

  push(
    'planning_notes',
    PLANNING_NOTES.map((p) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      category: p.category,
      content: p.content,
      status: 'extracted',
      source_channel: 'gmail',
      created_at: offsetIso(today, Math.max(0, wDays + rng.int(30, 200)), 12 * 60),
    })),
  )

  push(
    'commitment_reconciliation',
    COMMITMENTS.map((c, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      commitment_key: `${story.key}-${i}`,
      quote: c.quote,
      kind: c.kind,
      status: c.status,
      matched_event_title: c.status === 'matched' ? 'Speeches' : null,
      judge_reason:
        c.status === 'matched'
          ? 'The timeline already moves the speeches before the meal.'
          : c.status === 'dismissed'
            ? 'A coordinator decided this needs no event.'
            : null,
      first_seen_at: offsetIso(today, Math.max(0, wDays + rng.int(20, 120)), 12 * 60),
      last_checked_at: offsetIso(today, 0, 6 * 60),
    })),
  )

  push(
    'inspo_gallery',
    ['Tablescape', 'Arch', 'Bouquet', 'Lighting', 'Cake', 'Stationery'].map((tag, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      image_url: `https://example.com/inspo/${slugifyLocal(tag)}-${i}.jpg`,
      caption: `${tag}, saved from the couple's board.`,
      tags: [tag.toLowerCase()],
      created_at: offsetIso(today, Math.max(0, wDays + rng.int(30, 180)), 20 * 60),
    })),
  )

  push(
    'messages',
    [
      { role: 'couple', body: 'Is there somewhere for my aunt to sit during the drinks?' },
      { role: 'coordinator', body: 'There is, we keep two chairs by the orangery door for exactly that.' },
      { role: 'couple', body: 'Perfect, thank you.' },
    ].map((m, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      sender_role: m.role,
      content: m.body,
      read_at: i < 2 ? offsetIso(today, Math.max(0, wDays + 40), 14 * 60) : null,
      created_at: offsetIso(today, Math.max(0, wDays + 41 - i), 13 * 60 + i * 20),
    })),
  )

  if (story.lifecycle === 'completed') {
    push('event_feedback', [
      {
        id: uuidFrom(rng),
        venue_id: story.venueId,
        wedding_id: wRef,
        overall_rating: rng.int(4, 5),
        couple_satisfaction: rng.int(4, 5),
        timeline_adherence: rng.pick(['on_time', 'minor_delays']),
        guest_complaint_count: 0,
        catering_quality: rng.int(4, 5),
        dietary_handling: rng.int(4, 5),
        service_timing: rng.int(3, 5),
        review_readiness: rng.pick(['yes', 'wait']),
        what_went_well: 'The weather held and the ceremony started on time.',
        what_to_change: 'The bar queue was long for the first half hour.',
        feedback_triggered_at: offsetIso(today, Math.max(0, wDays - 2), 9 * 60),
        submitted_at: offsetIso(today, Math.max(0, wDays - 4), 16 * 60),
      },
    ])
  }

  // -- The day-of sheets. Journey 26 opens the table map and moves a
  //    guest; journey 27 reads the day-outlook card. Both want rows.
  // `table_map_layouts` is the one aux table with no `venue_id`, so the
  // reseed's venue-scoped delete cannot reach it. Every generated story
  // gets a fresh weddings row each run and the layout cascades away with
  // the old one, which keeps it idempotent. The hero's weddings row is
  // preserved, so its layout would survive and collide on
  // UNIQUE(wedding_id): the hero keeps the layout `supabase/seed.sql`
  // gave it instead.
  if (!story.hero) {
    push('table_map_layouts', [
      {
        id: uuidFrom(rng),
        wedding_id: wRef,
        elements: tables.map((t, i) => ({
          id: t.id,
          kind: 'table',
          label: t.table_name,
          x: 120 + (i % 3) * 180,
          y: 120 + Math.floor(i / 3) * 170,
          seats: t.capacity,
        })),
      },
    ])
  }

  push('wedding_config', [
    {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      total_budget: (story.bookingValue ?? venue.basePrice) * 2.4,
      budget_shared: true,
      plated_meal: rng.chance(0.6),
      custom_categories: ['Honeymoon', 'Stationery'],
    },
  ])

  push('wedding_details', [
    {
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      wedding_colors: rng.pick(['Sage and cream', 'Navy and rust', 'Dusty pink', 'Black tie, no colour']),
      ceremony_location: rng.pick(['outside', 'inside', 'both']),
      dogs_coming: rng.chance(0.3),
      dogs_description: 'One lurcher, in for the ceremony and then home.',
      seating_method: 'assigned tables',
      providing_table_numbers: true,
      providing_cake_cutter: false,
      send_off_type: rng.pick(['sparklers', 'dried petals', 'bubbles']),
      reception_notes: 'Long tables, greenery down the middle.',
      high_chairs: '2',
      wedding_party_count: String(rng.int(4, 10)),
    },
  ])

  push(
    'staffing_assignments',
    (['bartender', 'server', 'coordinator', 'runner', 'line_cook'] as const).map((role) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      role,
      count: role === 'coordinator' ? 1 : rng.int(2, 5),
      hourly_rate: role === 'coordinator' ? 38 : rng.int(18, 26),
      hours: 9,
      notes: null,
    })),
  )

  push(
    'shuttle_schedule',
    [
      { route: 'Hotel to venue', from: 'The market square hotel', to: venue.name, hour: 13 },
      { route: 'Venue to hotel, first run', from: venue.name, to: 'The market square hotel', hour: 22 },
      { route: 'Venue to hotel, last run', from: venue.name, to: 'The market square hotel', hour: 23 },
    ].map((r, i) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      route_name: r.route,
      pickup_location: r.from,
      dropoff_location: r.to,
      departure_time: offsetIso(today, wDays, r.hour * 60),
      capacity: 16,
      seat_count: 16,
      sort_order: i,
    })),
  )

  push(
    'sage_conversations',
    [
      { role: 'user', content: 'What time can our florist get in on the Friday?' },
      {
        role: 'assistant',
        content:
          'Suppliers can be on site from nine on the Friday, and the ceremony room is free from two.',
      },
      { role: 'user', content: 'And is there anywhere to store the arch overnight?' },
      {
        role: 'assistant',
        content: 'Yes, the back of the barn is dry and locked. I have noted it on your file.',
      },
    ].map((m) => ({
      id: uuidFrom(rng),
      venue_id: story.venueId,
      wedding_id: wRef,
      role: m.role,
      content: m.content,
      model_used: 'demo-seeded',
      confidence_score: 88,
      flagged_uncertain: false,
      created_at: offsetIso(today, Math.max(0, wDays + rng.int(20, 90)), 15 * 60),
    })),
  )

  // -- A pending portal invitation on the bookings that have not
  //    registered yet. `token_hash` is a sha256-shaped hex string; the
  //    plaintext is not stored and is not needed: nothing in the demo
  //    redeems these.
  if (rng.chance(0.5)) {
    push('couple_invites', [
      {
        id: uuidFrom(rng),
        venue_id: story.venueId,
        wedding_id: wRef,
        email: story.primaryEmail,
        token_hash: Array.from({ length: 64 }, () => rng.int(0, 15).toString(16)).join(''),
        expires_at: offsetIso(today, -rng.int(3, 14), 12 * 60),
        used_at: null,
        created_at: offsetIso(today, rng.int(1, 20), 12 * 60),
      },
    ])
  }

  return out
}

// ---------------------------------------------------------------------------
// Per-venue rows the reseed owns
// ---------------------------------------------------------------------------

const FRAGMENT_HINTS: readonly string[] = [
  'Sarah R.',
  '@meadowandmoss',
  'someone called Dan',
  'a saved listing, no name',
  '@twoofcupsphoto',
  'M. Whitfield',
  'a message with just a date in it',
]

/**
 * Unpromoted fragments and a review queue, per venue.
 *
 * Fragments are the honest half of the demo: signals that arrived without
 * enough identity to anchor. A demo with none of them tells the visitor
 * every signal resolves, which is the one thing the product promises it
 * does not pretend.
 */
export function buildVenueAux(
  venueId: string,
  today: string,
  seed: number,
  coupleRefs: readonly string[],
): AuxBundle[] {
  const rng = makeRng(seedFor(seed, `venue:${venueId}`))
  const out: AuxBundle[] = []

  out.push({
    table: 'fragments',
    rows: FRAGMENT_HINTS.map((hint, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      channel: rng.pick(['instagram', 'knot', 'weddingwire', 'web']),
      identity_hint: hint,
      external_id: `demo-reseed:fragment:${venueId}:${i}`,
      occurred_at: offsetIso(today, rng.int(1, 90), rng.int(8 * 60, 21 * 60)),
      raw_payload: { demo_reseed: true, note: 'Arrived without a reachable address.' },
      handles: hint.startsWith('@') ? { instagram: hint.slice(1) } : {},
      promoted_to_couple_id: null,
      promoted_at: null,
    })),
  })

  // A review queue with something actually in it. Pairs are drawn from
  // the venue's own couples, so nothing points across a venue boundary.
  if (coupleRefs.length >= 2) {
    const pairs: Array<Record<string, unknown>> = []
    for (let i = 0; i + 1 < Math.min(coupleRefs.length, 12); i += 2) {
      pairs.push({
        id: uuidFrom(rng),
        venue_id: venueId,
        primary_record_id: coupleRefs[i],
        primary_record_type: 'couple',
        secondary_record_id: coupleRefs[i + 1],
        secondary_record_type: 'couple',
        confidence_tier: rng.pick(['high', 'medium', 'low']),
        matcher_reason:
          'Same surname and a wedding date three days apart. Judge was not confident enough to merge.',
        created_at: offsetIso(today, rng.int(1, 30), 10 * 60),
        resolved_at: null,
        resolution: null,
      })
    }
    out.push({ table: 'candidate_matches', rows: pairs })
  }

  const venue = DEMO_VENUES.find((v) => v.id === venueId) ?? DEMO_VENUES[0]

  // -- Marketing spend, eighteen months of it, on the channel keys the
  //    spine already uses. `attributionChannelKey` and the ROI readers
  //    join spend to inquiries on these strings; spend filed under a
  //    channel no inquiry carries shows as unattributed and the ROI page
  //    reads as a row of dashes.
  const spend: Array<Record<string, unknown>> = []
  for (let monthsAgo = 0; monthsAgo < 18; monthsAgo++) {
    const spendDate = offsetDate(today, monthsAgo * 30 + 1)
    for (const channel of SPEND_CHANNELS) {
      spend.push({
        id: uuidFrom(rng),
        venue_id: venueId,
        channel: channel.key,
        campaign_id: channel.campaign ? `${channel.key}-${venue.slug}` : null,
        campaign_name: channel.campaign ? `${venue.name}: ${channel.label}` : null,
        spend_date: spendDate,
        amount_cents: channel.base * 100 + rng.int(-40, 90) * 100,
        currency: 'USD',
        source_platform_metadata: { demo_reseed: true, impressions: rng.int(4000, 40000) },
        ingested_by: channel.ingestedBy,
      })
    }
  }
  out.push({ table: 'marketing_spend_records', rows: spend })

  out.push({
    table: 'campaigns',
    rows: SPEND_CHANNELS.map((c) => {
      const inquiries = rng.int(4, 26)
      const bookings = Math.max(1, Math.round(inquiries * 0.18))
      const total = c.base * 6
      return {
        id: uuidFrom(rng),
        venue_id: venueId,
        name: `${c.label}, rolling`,
        channel: c.key,
        start_date: offsetDate(today, 180),
        end_date: offsetDate(today, -30),
        spend: total,
        inquiries_attributed: inquiries,
        tours_attributed: Math.round(inquiries * 0.45),
        bookings_attributed: bookings,
        revenue_attributed: bookings * venue.basePrice,
        cost_per_inquiry: Math.round(total / inquiries),
        cost_per_booking: Math.round(total / bookings),
        roi_ratio: Number(((bookings * venue.basePrice) / total).toFixed(2)),
      }
    }),
  })

  // -- Reviews. Four platforms, a spread of ratings, sentiment on every
  //    row, and dates inside the last two years so the trend chart has a
  //    slope rather than a single point.
  const reviews: Array<Record<string, unknown>> = []
  REVIEW_SOURCES.forEach((source, si) => {
    for (let i = 0; i < 4; i++) {
      const rating = i === 3 && si % 2 === 0 ? rng.int(2, 3) : rng.int(4, 5)
      const copy = rating >= 4 ? REVIEW_GOOD[(si + i) % REVIEW_GOOD.length] : REVIEW_MIXED[i % REVIEW_MIXED.length]
      reviews.push({
        id: uuidFrom(rng),
        venue_id: venueId,
        source,
        source_review_id: `demo-reseed:${venueId}:${source}:${i}`,
        reviewer_name: `${GUEST_FIRST[(si * 5 + i) % GUEST_FIRST.length]} ${GUEST_LAST[(si * 3 + i) % GUEST_LAST.length]}`,
        rating,
        title: null,
        body: copy.body,
        review_date: offsetDate(today, 20 + si * 90 + i * 45),
        sentiment_score: rating >= 4 ? 0.62 + i * 0.07 : -0.25 - i * 0.05,
        themes: copy.themes,
        is_featured: rating === 5 && i === 0,
        response_text: rating < 4 ? 'Thank you for this, we have changed how the bar is staffed.' : null,
        response_date: rating < 4 ? offsetDate(today, 14 + si * 90 + i * 45) : null,
      })
    }
  })
  out.push({ table: 'reviews', rows: reviews })

  out.push({
    table: 'review_language',
    rows: REVIEW_PHRASES.map((p) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      phrase: p.phrase,
      theme: p.theme,
      sentiment_score: p.sentiment,
      frequency: rng.int(3, 24),
      approved_for_sage: p.sentiment > 0,
      approved_for_marketing: p.sentiment > 0.5,
      source_type: 'review',
    })),
  })

  // -- Weather. An active alert on one venue, a recent expired one on
  //    every venue, and enough climate rows for the "is it getting
  //    wetter" card to have two decades to compare.
  out.push({
    table: 'weather_alerts',
    rows: WEATHER_ALERTS.map((a, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      nws_id: `demo-reseed:${venueId}:alert:${i}`,
      event: a.event,
      severity: a.severity,
      certainty: 'Likely',
      urgency: i === 0 ? 'Expected' : 'Past',
      headline: a.headline,
      description: a.description,
      instruction: 'Keep the marquee sides down and move the ceremony indoors if it holds.',
      area_desc: 'The county the venue sits in',
      status: 'Actual',
      message_type: 'Alert',
      // The first one is live right now; the rest already passed.
      onset: offsetIso(today, i === 0 ? 0 : 20 + i * 30, 6 * 60),
      ends: offsetIso(today, i === 0 ? -1 : 19 + i * 30, 22 * 60),
      expires: offsetIso(today, i === 0 ? -1 : 19 + i * 30, 22 * 60),
      is_active: i === 0,
      fetched_at: offsetIso(today, 0, 5 * 60),
    })),
  })

  const climateNorms: Array<Record<string, unknown>> = []
  for (let month = 4; month <= 10; month++) {
    for (const hour of [10, 14, 18]) {
      const warm = month >= 6 && month <= 8
      climateNorms.push({
        venue_id: venueId,
        month_num: month,
        hour_local: hour,
        recent_temp_avg_f: (warm ? 78 : 62) + (hour - 10),
        recent_temp_p10_f: (warm ? 66 : 50) + (hour - 10),
        recent_temp_p90_f: (warm ? 91 : 74) + (hour - 10),
        recent_precip_avg_in: 0.04 + month * 0.002,
        recent_precip_prob_pct: 18 + month,
        recent_sample_count: 310,
        prior_temp_avg_f: (warm ? 76 : 61) + (hour - 10),
        prior_precip_avg_in: 0.05 + month * 0.001,
        prior_precip_prob_pct: 16 + month,
        prior_sample_count: 310,
        recent_window_start: offsetDate(today, 3650),
        recent_window_end: offsetDate(today, 1),
        prior_window_start: offsetDate(today, 7300),
        prior_window_end: offsetDate(today, 3651),
        refreshed_at: offsetIso(today, 1, 4 * 60),
      })
    }
  }
  out.push({ table: 'weather_climate_norms', rows: climateNorms })

  const thisYear = new Date(today).getUTCFullYear()
  const climateAnnual: Array<Record<string, unknown>> = []
  for (let back = 0; back < 3; back++) {
    for (let month = 5; month <= 10; month++) {
      climateAnnual.push({
        venue_id: venueId,
        year: thisYear - back,
        month_num: month,
        mean_high_f: 70 + month - back,
        total_precip_in: Number((2.4 + month * 0.15 - back * 0.2).toFixed(2)),
        sample_days: 30,
        refreshed_at: offsetIso(today, 1, 4 * 60),
      })
    }
  }
  out.push({ table: 'weather_climate_annual', rows: climateAnnual })

  out.push({
    table: 'follow_up_sequences',
    rows: FOLLOW_UPS.map((f) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      name: f.name,
      description: f.description,
      trigger_type: f.trigger,
      trigger_config: { delay_days: f.delayDays },
      channel: f.channel,
      is_active: f.active,
    })),
  })

  out.push({
    table: 'packages',
    rows: buildPackages(venue),
  })

  out.push({
    table: 'storefront',
    rows: STOREFRONT_PICKS.map((p, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      pick_name: p.name,
      category: p.category,
      product_type: p.type,
      description: p.description,
      pick_type: p.pick,
      is_active: true,
      sort_order: i,
    })),
  })

  out.push({
    table: 'portal_section_config',
    rows: PORTAL_SECTIONS.map((s, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      section_key: s.key,
      label: s.label,
      description: null,
      visibility: s.visibility,
      sort_order: i,
      icon: s.icon,
    })),
  })

  out.push({
    table: 'venue_resources',
    rows: VENUE_RESOURCES.map((r, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      title: r.title,
      subtitle: r.subtitle,
      url: `https://example.com/${venue.slug}/${r.slug}`,
      icon: r.icon,
      is_external: true,
      sort_order: i,
      is_active: true,
    })),
  })

  out.push({
    table: 'accommodations',
    rows: ACCOMMODATIONS.map((a, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      name: a.name,
      type: a.type,
      address: a.address,
      website_url: `https://example.com/stay/${a.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      price_per_night: a.price,
      distance_miles: a.miles,
      description: a.description,
      is_recommended: i < 3,
      sort_order: i,
      block_code: i === 0 ? 'CRESTWOOD10' : null,
      block_deadline: i === 0 ? offsetDate(today, -60) : null,
    })),
  })

  out.push({
    table: 'voice_training_sessions',
    rows: (['would_you_send', 'cringe_or_fine', 'quick_quiz'] as const).flatMap((game, gi) =>
      [0, 1].map((n) => ({
        id: uuidFrom(rng),
        venue_id: venueId,
        game_type: game,
        completed_rounds: n === 0 ? 10 : rng.int(3, 8),
        total_rounds: 10,
        staff_email: `coordinator@${venue.slug}.example.com`,
        started_at: offsetIso(today, 20 + gi * 15 + n * 3, 11 * 60),
        completed_at: n === 0 ? offsetIso(today, 20 + gi * 15 + n * 3, 11 * 60 + 25) : null,
      })),
    ),
  })

  out.push({
    table: 'brain_dump_entries',
    rows: BRAIN_DUMPS.map((b, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      raw_input: b.text,
      input_type: b.type,
      parse_status: b.status,
      parsed_at: b.status === 'pending' ? null : offsetIso(today, 4 + i * 5, 9 * 60),
      created_at: offsetIso(today, 5 + i * 5, 8 * 60),
    })),
  })

  // -- The intelligence surfaces. Each of these was carrying two or three
  //    rows from the old seed, which renders as a page with one card on
  //    it and no way to tell whether the reader works.
  out.push({
    table: 'ai_briefings',
    rows: (['weekly', 'weekly', 'weekly', 'monthly', 'monthly', 'anomaly'] as const).map(
      (kind, i) => ({
        id: uuidFrom(rng),
        venue_id: venueId,
        briefing_type: kind,
        content: {
          headline:
            kind === 'anomaly'
              ? 'Inquiries from the Knot fell by a third last week'
              : `What moved at ${venue.name}`,
          points: [
            `${rng.int(4, 19)} new inquiries`,
            `${rng.int(1, 6)} tours booked`,
            `${rng.int(0, 3)} signed`,
          ],
        },
        delivered_via: i % 2 === 0 ? 'email' : 'in_app',
        delivered_at: offsetIso(today, 3 + i * 7, 7 * 60),
      }),
    ),
  })

  out.push({
    table: 'anomaly_alerts',
    rows: ANOMALIES.map((a, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      alert_type: a.type,
      metric_name: a.metric,
      current_value: a.current,
      baseline_value: a.baseline,
      change_percent: Number((((a.current - a.baseline) / a.baseline) * 100).toFixed(1)),
      severity: a.severity,
      ai_explanation: a.explanation,
      causes: { candidates: a.causes },
      acknowledged: i > 3,
      // Migration 252's CHECK allows only 'ai' | 'template' | 'rule'
      // (NULL is the legacy/unknown sentinel). These rows are canned
      // strings with no LLM ever attempted, so 'rule' would be the
      // more literal read, but every one of them is written to look
      // like the deterministic-template fallback a real detector
      // produces when the LLM narrator is unavailable — 'template' is
      // the honest label for that shape.
      explanation_source: 'template',
      created_at: offsetIso(today, 2 + i * 6, 6 * 60),
    })),
  })

  out.push({
    table: 'learned_preferences',
    rows: LEARNED.map((p) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      preference_type: p.type,
      pattern: p.pattern,
      confidence: p.confidence,
      created_at: offsetIso(today, rng.int(10, 120), 10 * 60),
    })),
  })

  out.push({
    table: 'natural_language_queries',
    rows: NL_QUERIES.map((q, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      query_text: q.question,
      response_text: q.answer,
      model_used: 'demo-seeded',
      tokens_used: rng.int(400, 1800),
      cost: 0.012,
      helpful: i % 3 !== 2,
      created_at: offsetIso(today, 1 + i * 4, 15 * 60),
    })),
  })

  out.push({
    table: 'phrase_usage',
    rows: REVIEW_PHRASES.slice(0, 6).map((p, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      contact_email: `lead${i}@example.org`,
      phrase_category: p.theme,
      phrase_text: p.phrase,
      used_at: offsetIso(today, 2 + i * 9, 11 * 60),
      confidence_flag: 'live',
    })),
  })

  out.push({
    table: 'trend_recommendations',
    rows: TREND_RECS.map((t, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      recommendation_type: t.type,
      title: t.title,
      body: t.body,
      data_source: t.source,
      supporting_data: { sample: rng.int(20, 140) },
      priority: i === 0 ? 'high' : i < 3 ? 'medium' : 'low',
      status: i < 3 ? 'pending' : i === 3 ? 'applied' : 'dismissed',
      applied_at: i === 3 ? offsetIso(today, 8, 10 * 60) : null,
      dismissed_at: i > 3 ? offsetIso(today, 12, 10 * 60) : null,
      created_at: offsetIso(today, 6 + i * 5, 9 * 60),
    })),
  })

  out.push({
    table: 'email_sync_state',
    rows: [
      {
        id: uuidFrom(rng),
        venue_id: venueId,
        last_history_id: String(9_000_000 + rng.int(1, 99_999)),
        last_sync_at: offsetIso(today, 0, 6 * 60),
        status: 'ok',
        error_message: null,
      },
    ],
  })

  out.push({
    table: 'brand_assets',
    rows: BRAND_ASSETS.map((a, i) => ({
      id: uuidFrom(rng),
      venue_id: venueId,
      asset_type: a.type,
      label: a.label,
      url: `https://example.com/${venue.slug}/assets/${a.label.toLowerCase().replace(/[^a-z]+/g, '-')}.jpg`,
      caption: a.caption,
      category: a.category,
      couple_facing: a.coupleFacing,
      sage_eligible: a.coupleFacing,
      sort_order: i,
      mime_type: 'image/jpeg',
    })),
  })

  return out
}

// ---------------------------------------------------------------------------
// Venue-level word lists
// ---------------------------------------------------------------------------

/**
 * Spend channel keys. These are the strings the attribution readers join
 * on, not free copy: 'the_knot' and 'weddingwire' match `weddings.source`,
 * 'google_ads' / 'meta_ads' / 'tiktok_ads' match the ad connectors.
 */
const SPEND_CHANNELS: ReadonlyArray<{
  key: string
  label: string
  base: number
  campaign: boolean
  ingestedBy: string
}> = [
  { key: 'google_ads', label: 'Search', base: 640, campaign: true, ingestedBy: 'google_ads_connector' },
  { key: 'meta_ads', label: 'Instagram and Facebook', base: 480, campaign: true, ingestedBy: 'meta_ads_connector' },
  { key: 'tiktok_ads', label: 'TikTok', base: 180, campaign: true, ingestedBy: 'tiktok_ads_connector' },
  { key: 'theknot_fee', label: 'The Knot listing', base: 750, campaign: false, ingestedBy: 'theknot_manual' },
  { key: 'weddingwire_fee', label: 'WeddingWire listing', base: 520, campaign: false, ingestedBy: 'manual' },
  { key: 'organic_seo', label: 'Content and SEO', base: 300, campaign: false, ingestedBy: 'manual' },
]

const REVIEW_SOURCES: readonly string[] = ['google', 'the_knot', 'wedding_wire', 'facebook']

const REVIEW_GOOD: ReadonlyArray<{ body: string; themes: string[] }> = [
  {
    body: 'The coordinator answered every message within the hour and the day ran itself. Our guests are still talking about the walled garden.',
    themes: ['responsiveness', 'grounds'],
  },
  {
    body: 'We booked eighteen months out and never once felt forgotten. The food was better than the tasting, which never happens.',
    themes: ['communication', 'catering'],
  },
  {
    body: 'Rain all morning and they moved the whole ceremony inside without anyone noticing. Worth every penny.',
    themes: ['weather', 'flexibility'],
  },
  {
    body: 'My father uses a wheelchair and they had thought about it before we asked. That mattered more than anything else.',
    themes: ['accessibility', 'care'],
  },
]

const REVIEW_MIXED: ReadonlyArray<{ body: string; themes: string[] }> = [
  {
    body: 'Lovely venue, but the bar queue in the first hour was long and we had said we expected a crowd.',
    themes: ['bar', 'staffing'],
  },
  {
    body: 'The day itself was good. Getting answers in the month before it was slower than we would have liked.',
    themes: ['responsiveness'],
  },
]

const REVIEW_PHRASES: ReadonlyArray<{ phrase: string; theme: string; sentiment: number }> = [
  { phrase: 'the walled garden', theme: 'grounds', sentiment: 0.86 },
  { phrase: 'answered within the hour', theme: 'responsiveness', sentiment: 0.81 },
  { phrase: 'better than the tasting', theme: 'catering', sentiment: 0.78 },
  { phrase: 'moved it inside without a fuss', theme: 'flexibility', sentiment: 0.72 },
  { phrase: 'step-free the whole way', theme: 'accessibility', sentiment: 0.69 },
  { phrase: 'the bar queue', theme: 'bar', sentiment: -0.41 },
  { phrase: 'slow to reply in the last month', theme: 'responsiveness', sentiment: -0.36 },
]

const WEATHER_ALERTS: ReadonlyArray<{ event: string; severity: string; headline: string; description: string }> = [
  {
    event: 'Wind Advisory',
    severity: 'Moderate',
    headline: 'Wind Advisory in effect until this evening',
    description: 'Southwest wind 20 to 30 mph with gusts to 45 mph.',
  },
  {
    event: 'Flood Watch',
    severity: 'Severe',
    headline: 'Flood Watch through the weekend',
    description: 'Two to four inches of rain expected across the county.',
  },
  {
    event: 'Heat Advisory',
    severity: 'Moderate',
    headline: 'Heat Advisory for Saturday afternoon',
    description: 'Heat index values up to 105 expected.',
  },
  {
    event: 'Frost Advisory',
    severity: 'Minor',
    headline: 'Frost Advisory overnight',
    description: 'Temperatures near 32 degrees for a few hours before dawn.',
  },
  {
    event: 'Severe Thunderstorm Watch',
    severity: 'Severe',
    headline: 'Severe Thunderstorm Watch until midnight',
    description: 'Damaging wind and hail possible.',
  },
]

const FOLLOW_UPS: ReadonlyArray<{
  name: string
  description: string
  trigger: string
  delayDays: number
  channel: string
  active: boolean
}> = [
  { name: 'Nudge after the tour', description: 'Two days after a tour with no reply.', trigger: 'post_tour', delayDays: 2, channel: 'email', active: true },
  { name: 'Second nudge after the tour', description: 'A week later, shorter.', trigger: 'post_tour', delayDays: 7, channel: 'email', active: true },
  { name: 'Gone quiet', description: 'Fourteen days of silence on an open inquiry.', trigger: 'ghosted', delayDays: 14, channel: 'email', active: true },
  { name: 'Gone quiet, by text', description: 'The same, for the couples who only ever text.', trigger: 'ghosted', delayDays: 14, channel: 'sms', active: false },
  { name: 'Welcome after booking', description: 'The day after the contract is signed.', trigger: 'post_booking', delayDays: 1, channel: 'email', active: true },
  { name: 'Six weeks out', description: 'Final details and the balance.', trigger: 'pre_event', delayDays: 42, channel: 'email', active: true },
]

function buildPackages(venue: { id: string; name: string; basePrice: number }): Array<Record<string, unknown>> {
  const seasons: ReadonlyArray<{ season: string; multiplier: number }> = [
    { season: 'spring', multiplier: 1 },
    { season: 'summer', multiplier: 1.18 },
    { season: 'fall', multiplier: 1.1 },
    { season: 'winter', multiplier: 0.82 },
  ]
  const rows: Array<Record<string, unknown>> = seasons.map((s) => ({
    venue_id: venue.id,
    kind: 'package',
    name: s.season.charAt(0).toUpperCase() + s.season.slice(1),
    season: s.season,
    tier: 'standard',
    guest_count_min: 50,
    guest_count_max: 200,
    price_cents: Math.round(venue.basePrice * s.multiplier) * 100,
    status: 'active',
    confidence_flag: 'live',
    description: `${venue.name}, full-day hire, ${s.season}.`,
  }))
  rows.push(
    {
      venue_id: venue.id,
      kind: 'upgrade',
      name: 'Rehearsal dinner on site',
      guest_count_min: 20,
      guest_count_max: 60,
      price_cents: 200000,
      status: 'active',
      confidence_flag: 'live',
      description: 'Up to four hours the evening before.',
    },
    {
      venue_id: venue.id,
      kind: 'upgrade',
      name: 'Extra hour',
      price_cents: 60000,
      status: 'active',
      confidence_flag: 'live',
      description: 'One additional hour at the end of the night.',
    },
    {
      venue_id: venue.id,
      kind: 'discount',
      name: 'Military, veteran and front-line responders',
      discount_percent: 10,
      status: 'active',
      confidence_flag: 'live',
      description: null,
    },
  )
  return rows
}

const STOREFRONT_PICKS: ReadonlyArray<{
  name: string
  category: string
  type: string
  description: string
  pick: string
}> = [
  { name: 'Linen table runner', category: 'Tables', type: 'linen', description: 'Washed linen, comes in six colours.', pick: 'Best Save' },
  { name: 'Hand-thrown bud vases', category: 'Tables', type: 'ceramics', description: 'A set of twelve, small enough not to block a face.', pick: 'Best Splurge' },
  { name: 'Weatherproof aisle markers', category: 'Ceremony', type: 'signage', description: 'They survive a wet morning.', pick: 'Best Practical' },
  { name: 'Wildflower seed favours', category: 'Favours', type: 'favours', description: 'Native mix, sowable in autumn.', pick: 'Fall/Winter' },
  { name: 'Paper lanterns', category: 'Lighting', type: 'lighting', description: 'Warm, cheap, and they photograph well.', pick: 'Spring/Summer' },
  { name: 'Monogram cake topper', category: 'Cake', type: 'decor', description: 'Cut to your own initials.', pick: 'Best Custom' },
]

const PORTAL_SECTIONS: ReadonlyArray<{ key: string; label: string; visibility: string; icon: string }> = [
  { key: 'timeline', label: 'Your day', visibility: 'both', icon: 'clock' },
  { key: 'guests', label: 'Guest list', visibility: 'both', icon: 'users' },
  { key: 'seating', label: 'Seating', visibility: 'both', icon: 'grid' },
  { key: 'budget', label: 'Budget', visibility: 'both', icon: 'wallet' },
  { key: 'contracts', label: 'Contracts', visibility: 'both', icon: 'file-text' },
  { key: 'vendors', label: 'Suppliers', visibility: 'both', icon: 'briefcase' },
  { key: 'internal_notes', label: 'Internal notes', visibility: 'admin_only', icon: 'lock' },
]

const VENUE_RESOURCES: ReadonlyArray<{ title: string; subtitle: string; slug: string; icon: string }> = [
  { title: 'Getting here', subtitle: 'Directions and parking', slug: 'directions', icon: 'map' },
  { title: 'Where to stay', subtitle: 'Rooms within fifteen minutes', slug: 'stay', icon: 'bed' },
  { title: 'Accessibility', subtitle: 'Step-free routes and what to ask for', slug: 'access', icon: 'accessibility' },
  { title: 'Supplier list', subtitle: 'People we have worked with often', slug: 'suppliers', icon: 'briefcase' },
  { title: 'House rules', subtitle: 'Noise, candles, confetti', slug: 'rules', icon: 'scroll' },
]

const ANOMALIES: ReadonlyArray<{
  type: string
  metric: string
  current: number
  baseline: number
  severity: string
  explanation: string
  causes: string[]
}> = [
  { type: 'volume_drop', metric: 'weekly_inquiries', current: 6, baseline: 11, severity: 'warning', explanation: 'Knot inquiries fell while the website held steady, which usually means the listing slipped down the page.', causes: ['listing position', 'seasonal'] },
  { type: 'response_time', metric: 'median_first_response_hours', current: 26, baseline: 7, severity: 'critical', explanation: 'First replies took most of a day last week. Two of the three coordinators were away.', causes: ['coordinator absence'] },
  { type: 'conversion_drop', metric: 'tour_to_booking', current: 0.18, baseline: 0.31, severity: 'warning', explanation: 'Tours are holding but fewer are signing. Worth reading the last five lost-deal reasons.', causes: ['pricing', 'competitor'] },
  { type: 'spend_spike', metric: 'cost_per_inquiry', current: 84, baseline: 41, severity: 'warning', explanation: 'Search spend doubled without more inquiries.', causes: ['bid change'] },
  { type: 'volume_spike', metric: 'weekly_inquiries', current: 19, baseline: 11, severity: 'info', explanation: 'A busy week after the open day.', causes: ['open day'] },
  { type: 'sentiment_shift', metric: 'review_sentiment', current: 0.44, baseline: 0.71, severity: 'info', explanation: 'Two reviews mentioned the bar queue.', causes: ['bar staffing'] },
]

const LEARNED: ReadonlyArray<{ type: string; pattern: string; confidence: number }> = [
  { type: 'tone', pattern: 'Opens with the couple’s names, never "Dear both".', confidence: 0.91 },
  { type: 'tone', pattern: 'Never uses an exclamation mark after the first line.', confidence: 0.84 },
  { type: 'pricing', pattern: 'Gives the Friday rate unprompted when the enquiry mentions budget.', confidence: 0.77 },
  { type: 'structure', pattern: 'Two short paragraphs, then one question.', confidence: 0.88 },
  { type: 'timing', pattern: 'Replies to weekend enquiries on Monday morning, not Sunday night.', confidence: 0.72 },
  { type: 'content', pattern: 'Mentions the walled garden when the enquiry mentions photographs.', confidence: 0.69 },
]

const NL_QUERIES: ReadonlyArray<{ question: string; answer: string }> = [
  { question: 'Which channel brought the most bookings this year?', answer: 'The Knot, with nine, ahead of the website at six.' },
  { question: 'How long are we taking to reply?', answer: 'Seven hours on the median, and twenty-six on the slowest week.' },
  { question: 'What do people say when they go elsewhere?', answer: 'Price first, then a date we could not hold.' },
  { question: 'Are Fridays worth discounting?', answer: 'Friday bookings convert at a similar rate, and the rate is lower, so the revenue per enquiry is worse.' },
  { question: 'How many tours do we run a month?', answer: 'Between four and eleven, with a clear May peak.' },
  { question: 'Who has not replied to us in a fortnight?', answer: 'Five couples, three of them post-tour.' },
]

const TREND_RECS: ReadonlyArray<{ type: string; title: string; body: string; source: string }> = [
  { type: 'pricing', title: 'Hold the Friday rate where it is', body: 'Friday enquiries are up and converting at the same rate as Saturday. Discounting them further would cost revenue you are already getting.', source: 'internal' },
  { type: 'content', title: 'Put the accessibility page in the first reply', body: 'Four of the last twenty enquiries asked about step-free access before they asked about price.', source: 'reviews' },
  { type: 'channel', title: 'The Knot listing is worth re-photographing', body: 'Views are flat while impressions rose, which is usually the lead image.', source: 'external' },
  { type: 'operations', title: 'Add a bartender for the first hour', body: 'The bar queue has come up in two reviews and one debrief.', source: 'reviews' },
  { type: 'content', title: 'Say the capacity number in the listing headline', body: 'Half the enquiries ask it in the first message.', source: 'internal' },
  { type: 'channel', title: 'TikTok spend is not earning its place', body: 'Three months, no attributed inquiry.', source: 'internal' },
]

const ACCOMMODATIONS: ReadonlyArray<{
  name: string
  type: string
  address: string
  price: number
  miles: number
  description: string
}> = [
  { name: 'The Market Square Hotel', type: 'hotel', address: '2 Market Square', price: 145, miles: 3.1, description: 'Twelve minutes by car, and they hold a block for us.' },
  { name: 'Windle Farm Cottages', type: 'airbnb', address: 'Windle Lane', price: 210, miles: 1.4, description: 'Three cottages, sleeps fourteen between them.' },
  { name: 'The Old Brewery Inn', type: 'inn', address: 'Brewery Row', price: 110, miles: 4.6, description: 'Cheap, clean, good breakfast.' },
  { name: 'Ashen House', type: 'boutique', address: 'Ashen Hill', price: 280, miles: 6.2, description: 'Where most parents end up.' },
  { name: 'Riverside Lodges', type: 'vrbo', address: 'Mill Road', price: 165, miles: 5.0, description: 'Good for a group, but no taxis after eleven.' },
]

const BRAIN_DUMPS: ReadonlyArray<{ text: string; type: string; status: string }> = [
  { text: 'Two couples asked about dogs this week. We should put it on the FAQ.', type: 'text', status: 'parsed' },
  { text: 'The Friday rate confused three people in a row. Rewrite that line.', type: 'text', status: 'confirmed' },
  { text: 'Photo of the new arbor, six foot, birch.', type: 'image', status: 'pending' },
  { text: 'Voice note from the walk-round: bar queue, again.', type: 'voice', status: 'needs_clarification' },
  { text: 'Spreadsheet of next season prices.', type: 'csv', status: 'dismissed' },
]

/**
 * `category` is the internal Sage-matching taxonomy from migration 243
 * (`ceremony` / `tent` / `reception` / `detail` / `aerial` /
 * `venue_exterior` / `staff` / `other`), which is deliberately NOT the
 * same vocabulary as `asset_type` (media-type: `logo` / `hero_image` /
 * `photography` / `texture` / `icon`). Reusing `type` as `category`
 * (W72 finding 3) wrote values the CHECK constraint rejects outright.
 */
const BRAND_ASSETS: ReadonlyArray<{
  type: string
  category: string
  label: string
  caption: string
  coupleFacing: boolean
}> = [
  { type: 'logo', category: 'other', label: 'Primary logo', caption: 'On light backgrounds.', coupleFacing: false },
  { type: 'hero_image', category: 'venue_exterior', label: 'Front elevation', caption: 'Late afternoon, early June.', coupleFacing: true },
  { type: 'photography', category: 'ceremony', label: 'Ceremony room', caption: 'Set for eighty.', coupleFacing: true },
  { type: 'photography', category: 'reception', label: 'Walled garden', caption: 'Drinks reception.', coupleFacing: true },
  { type: 'texture', category: 'detail', label: 'Stone wall', caption: 'Background texture for print.', coupleFacing: false },
  { type: 'icon', category: 'other', label: 'Monogram', caption: 'For stationery.', coupleFacing: false },
]

/** Every aux bundle for a whole dataset, keyed by story. Convenience for
 *  the plan builder and for a test that wants the whole picture. */
export function buildAllAux(dataset: DemoDataset): Map<string, AuxBundle[]> {
  const out = new Map<string, AuxBundle[]>()
  for (const story of dataset.stories) {
    out.set(story.key, buildStoryAux(story, dataset.today, dataset.seed))
  }
  return out
}
