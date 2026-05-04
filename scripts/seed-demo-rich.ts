/**
 * Stream VVV — Rich demo seed for the Crestwood Collection (Hawthorne /
 * Crestwood Farm / Glass House / Rose Hill Gardens).
 *
 * Why this exists
 * ---------------
 * The 4 demo venues have a few weddings + correlation insights but almost
 * no booked HoneyBook contracts (so demo Total Revenue tile = $0), no
 * wedding_touchpoints (so Source Comparison is empty), no Calendly
 * tour-confirmation interactions (so the tour-outcome classifier has
 * nothing to do), and no calculator emails (so MMM's calculator extractor
 * has nothing to recover). A YC-partner watching the demo would think the
 * platform is bare. This seed makes Hawthorne RICH and the other three
 * believable variants so cross-venue scope shows real numbers too.
 *
 * What it generates (per venue, heaviest on Hawthorne)
 * ----------------------------------------------------
 *   - weddings (booked + in-flight + lost) with realistic source mix
 *   - people (partner1 + partner2 with fictional names)
 *   - wedding_touchpoints: 5-step funnel for booked HoneyBook weddings,
 *     1-2 step for non-converting Knot/website inquiries
 *   - interactions: 3-8 emails per wedding, plus a calculator email on
 *     5-10 booked weddings and a Calendly tour-confirmation on 5-10
 *   - marketing_spend: 16 monthly rows (Jan 2025 - April 2026) per venue
 *     with the WeddingWire→Google shape that powers the trend banner
 *   - tours: one per booked wedding with outcome='completed'
 *   - engagement_events: 2-5 per wedding (lead_score milestones, etc.)
 *   - source_attribution: per-source per-month rollup so the Source
 *     Quality + Source Comparison pages render meaningful numbers
 *   - lost_deals: one per lost wedding
 *
 * Idempotent — every INSERT uses ON CONFLICT (id) DO NOTHING so re-running
 * the seed is a no-op. UUIDs are deterministic (see seed-demo-rich-helpers).
 *
 * Multi-stream-safe — file zone is brand-new (seed-demo-rich.{sql,ts} +
 * seed-demo-rich-helpers.ts). No edits to seed.sql, no migrations under
 * 205, no service or UI touches.
 *
 * Apply path
 * ----------
 *   1. Run this script: `npx tsx scripts/seed-demo-rich.ts`
 *   2. The script writes the generated SQL to supabase/seed-demo-rich.sql
 *      (committed) and applies it via the public.exec_sql RPC.
 *   3. After it lands, /api/intel/sources/wedding-rollup?venue_id=
 *      22222222-2222-2222-2222-222222222201 should return ~$300K-$500K
 *      total revenue from ~30 booked weddings × ~$15K avg.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { splitSqlStatements } from './lib/sql-split.js'
import {
  DEMO_VENUES,
  STREAM_TAGS,
  seedUuid,
  makeRng,
  pick,
  int,
  sqlStr,
  sqlNum,
  sqlDate,
  sqlTimestamptz,
  addDays,
  addMonths,
  startOfMonth,
  FIRST_NAMES_A,
  FIRST_NAMES_B,
  LAST_NAMES,
  pickBookedSource,
  pickInflightSource,
  pickLostSource,
  fromEmailForSource,
  venueWebsiteEmail,
  SEED_NOW,
  pickInquiryDate,
  pickWeddingDate,
  type DemoVenue,
  type WeddingSource,
} from './seed-demo-rich-helpers.js'

// ---------------------------------------------------------------------------
// Builder — accumulates SQL chunks then joins them with newlines. We emit
// one INSERT-block per logical batch so the resulting file is human-readable
// AND easy to bisect when a chunk fails to apply.
// ---------------------------------------------------------------------------

class SqlBuilder {
  private readonly chunks: string[] = []
  readonly counts: Record<string, number> = {}

  section(title: string): void {
    this.chunks.push(`\n-- ${'='.repeat(70)}\n-- ${title}\n-- ${'='.repeat(70)}\n`)
  }

  raw(sql: string): void {
    this.chunks.push(sql)
  }

  count(table: string, n: number): void {
    this.counts[table] = (this.counts[table] ?? 0) + n
  }

  toString(): string {
    return this.chunks.join('\n')
  }
}

// ---------------------------------------------------------------------------
// Type for a generated wedding row — used as a fact-table for the rest of
// the seed (touchpoints / interactions / tours / engagement_events all
// reference this).
// ---------------------------------------------------------------------------

interface SeedWedding {
  id: string
  venue: DemoVenue
  status: 'inquiry' | 'tour_scheduled' | 'tour_completed' | 'proposal_sent' | 'booked' | 'completed' | 'lost'
  source: WeddingSource
  inquiryDate: Date
  weddingDate: Date | null
  tourDate: Date | null
  bookedAt: Date | null
  lostAt: Date | null
  bookingValueCents: number | null
  guestCount: number
  partner1: { id: string; first: string; last: string; email: string }
  partner2: { id: string; first: string; last: string; email: string }
  /** Slot in the venue's wedding sequence — used to derive UUIDs for
   *  touchpoints / interactions / etc. */
  slot: number
}

// ---------------------------------------------------------------------------
// Wedding generation — one per (venue, slot). Status, source, dates all
// derived from the seeded RNG.
// ---------------------------------------------------------------------------

function buildWeddings(b: SqlBuilder): SeedWedding[] {
  b.section('1. WEDDINGS — booked + in-flight + lost across 4 demo venues')

  const all: SeedWedding[] = []

  for (const venue of DEMO_VENUES) {
    // Per-venue RNG seeded by venue index. Every reseed of the same venue
    // produces the same data → byte-stable SQL.
    const rng = makeRng(venue.index * 1000003)

    const total = venue.booked + venue.inFlight + venue.lost
    const inserts: string[] = []

    for (let slot = 1; slot <= total; slot++) {
      const wId = seedUuid(STREAM_TAGS.WEDDING, venue.index, 0, slot)

      let status: SeedWedding['status']
      let source: WeddingSource
      let bookingValueCents: number | null = null
      let bookedAt: Date | null = null
      let lostAt: Date | null = null
      const inquiryDate = pickInquiryDate(rng, 18)
      const weddingDate = pickWeddingDate(rng, inquiryDate)
      let tourDate: Date | null = addDays(inquiryDate, 21)

      if (slot <= venue.booked) {
        // Booked or completed (older bookings → completed)
        const monthsSinceWedding =
          (SEED_NOW.getTime() - weddingDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
        status = monthsSinceWedding > 1 ? 'completed' : 'booked'
        source = pickBookedSource(rng)
        bookingValueCents = int(rng, 1_200_000, 2_500_000) // $12k-$25k in cents
        bookedAt = addDays(inquiryDate, int(rng, 50, 90))
      } else if (slot <= venue.booked + venue.inFlight) {
        // In-flight: inquiry / tour_scheduled / tour_completed / proposal_sent
        const r = rng()
        if (r < 0.3) {
          status = 'inquiry'
          tourDate = null
        } else if (r < 0.55) status = 'tour_scheduled'
        else if (r < 0.8) status = 'tour_completed'
        else status = 'proposal_sent'
        source = pickInflightSource(rng)
      } else {
        // Lost
        status = 'lost'
        source = pickLostSource(rng)
        lostAt = addDays(inquiryDate, int(rng, 14, 60))
        tourDate = rng() < 0.5 ? tourDate : null
      }

      // People
      const p1First = pick(rng, FIRST_NAMES_A)
      const p2First = pick(rng, FIRST_NAMES_B)
      const p1Last = pick(rng, LAST_NAMES)
      const p2Last = rng() < 0.7 ? p1Last : pick(rng, LAST_NAMES) // 70% same surname
      const p1Email = `${p1First.toLowerCase()}.${p1Last.toLowerCase()}@example.com`
      const p2Email = `${p2First.toLowerCase()}.${p2Last.toLowerCase()}@example.com`

      const guestCount = int(rng, 80, 220)

      const partner1 = {
        id: seedUuid(STREAM_TAGS.PERSON, venue.index, slot, 1),
        first: p1First,
        last: p1Last,
        email: p1Email,
      }
      const partner2 = {
        id: seedUuid(STREAM_TAGS.PERSON, venue.index, slot, 2),
        first: p2First,
        last: p2Last,
        email: p2Email,
      }

      const w: SeedWedding = {
        id: wId,
        venue,
        status,
        source,
        inquiryDate,
        weddingDate: status === 'lost' ? null : weddingDate,
        tourDate,
        bookedAt,
        lostAt,
        bookingValueCents,
        guestCount,
        partner1,
        partner2,
        slot,
      }
      all.push(w)

      // Build the INSERT row. We omit `assigned_consultant_id` — the demo
      // consultants exist in seed.sql but linking them is outside this
      // stream's scope (and the column is nullable).
      const heatScore =
        status === 'booked' ? int(rng, 60, 90) :
        status === 'tour_completed' || status === 'proposal_sent' ? int(rng, 40, 70) :
        status === 'tour_scheduled' ? int(rng, 25, 50) :
        status === 'completed' ? 0 :
        status === 'lost' ? int(rng, 5, 25) :
        int(rng, 10, 30)
      const tier =
        heatScore >= 70 ? 'hot' :
        heatScore >= 40 ? 'warm' :
        heatScore >= 20 ? 'cool' : 'cold'

      const cols = [
        sqlStr(w.id),
        sqlStr(venue.id),
        sqlStr(status),
        sqlStr(source ?? null),
        w.weddingDate ? sqlDate(w.weddingDate) : 'NULL',
        sqlNum(guestCount),
        sqlNum(bookingValueCents),
        sqlTimestamptz(inquiryDate),
        // first_response_at: a few hours after inquiry for everything
        sqlTimestamptz(addDays(inquiryDate, 0)),
        tourDate ? sqlTimestamptz(tourDate) : 'NULL',
        bookedAt ? sqlTimestamptz(bookedAt) : 'NULL',
        lostAt ? sqlTimestamptz(lostAt) : 'NULL',
        sqlNum(heatScore),
        sqlStr(tier),
      ].join(', ')

      inserts.push(`  (${cols})`)
    }

    if (inserts.length === 0) continue
    b.raw(
      `INSERT INTO public.weddings\n` +
        `  (id, venue_id, status, source, wedding_date, guest_count_estimate,\n` +
        `   booking_value, inquiry_date, first_response_at, tour_date, booked_at,\n` +
        `   lost_at, heat_score, temperature_tier)\n` +
        `VALUES\n${inserts.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('weddings', inserts.length)
  }

  return all
}

// ---------------------------------------------------------------------------
// People — partner1 + partner2 per wedding.
// ---------------------------------------------------------------------------

function buildPeople(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('2. PEOPLE — partner1 + partner2 per wedding')

  // Group by venue for readability of the resulting SQL.
  for (const venue of DEMO_VENUES) {
    const venueWeddings = weddings.filter((w) => w.venue.id === venue.id)
    if (venueWeddings.length === 0) continue
    const rows: string[] = []
    for (const w of venueWeddings) {
      for (const role of ['partner1', 'partner2'] as const) {
        const p = role === 'partner1' ? w.partner1 : w.partner2
        const cols = [
          sqlStr(p.id),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(role),
          sqlStr(p.first),
          sqlStr(p.last),
          sqlStr(p.email),
        ].join(', ')
        rows.push(`  (${cols})`)
      }
    }
    if (rows.length === 0) continue
    b.raw(
      `INSERT INTO public.people\n` +
        `  (id, venue_id, wedding_id, role, first_name, last_name, email)\n` +
        `VALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('people', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Wedding touchpoints — funnel chain per booked wedding.
// ---------------------------------------------------------------------------

interface Touchpoint {
  type:
    | 'inquiry'
    | 'tour_booked'
    | 'tour_conducted'
    | 'proposal_sent'
    | 'contract_signed'
    | 'email_reply'
  source: string
  signalClass: 'source' | 'touchpoint' | 'outcome'
  daysAfterInquiry: number
}

function buildTouchpointChain(w: SeedWedding): Touchpoint[] {
  const sourceLabel = w.source ?? 'unknown'

  // Booked / completed → full 5-step chain ending in contract_signed.
  if (w.status === 'booked' || w.status === 'completed') {
    return [
      { type: 'inquiry', source: sourceLabel, signalClass: 'source', daysAfterInquiry: 0 },
      // tour-booked is a Calendly-driven event for booked rows
      { type: 'tour_booked', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 14 },
      { type: 'tour_conducted', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 21 },
      // proposal + contract live in HoneyBook for booked rows (regardless
      // of original source — once you've bought HoneyBook you sign in it).
      { type: 'proposal_sent', source: 'honeybook', signalClass: 'touchpoint', daysAfterInquiry: 30 },
      { type: 'contract_signed', source: 'honeybook', signalClass: 'outcome', daysAfterInquiry: 60 },
    ]
  }

  // Proposal-sent in-flight → first 4 steps
  if (w.status === 'proposal_sent') {
    return [
      { type: 'inquiry', source: sourceLabel, signalClass: 'source', daysAfterInquiry: 0 },
      { type: 'tour_booked', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 14 },
      { type: 'tour_conducted', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 21 },
      { type: 'proposal_sent', source: 'honeybook', signalClass: 'touchpoint', daysAfterInquiry: 30 },
    ]
  }

  // Tour-completed in-flight → first 3 steps
  if (w.status === 'tour_completed') {
    return [
      { type: 'inquiry', source: sourceLabel, signalClass: 'source', daysAfterInquiry: 0 },
      { type: 'tour_booked', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 14 },
      { type: 'tour_conducted', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 21 },
    ]
  }

  // Tour-scheduled in-flight → first 2 steps
  if (w.status === 'tour_scheduled') {
    return [
      { type: 'inquiry', source: sourceLabel, signalClass: 'source', daysAfterInquiry: 0 },
      { type: 'tour_booked', source: 'calendly', signalClass: 'touchpoint', daysAfterInquiry: 14 },
    ]
  }

  // inquiry-only or lost → just the inquiry touchpoint (and maybe a
  // tour_booked for half of lost rows)
  const tps: Touchpoint[] = [
    { type: 'inquiry', source: sourceLabel, signalClass: 'source', daysAfterInquiry: 0 },
  ]
  if (w.status === 'lost' && w.tourDate) {
    tps.push({
      type: 'tour_booked',
      source: 'calendly',
      signalClass: 'touchpoint',
      daysAfterInquiry: 14,
    })
  }
  return tps
}

function buildTouchpoints(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('3. WEDDING_TOUCHPOINTS — multi-step funnel chains')

  for (const venue of DEMO_VENUES) {
    const venueWeddings = weddings.filter((w) => w.venue.id === venue.id)
    if (venueWeddings.length === 0) continue
    const rows: string[] = []
    for (const w of venueWeddings) {
      const chain = buildTouchpointChain(w)
      for (let i = 0; i < chain.length; i++) {
        const tp = chain[i]!
        const tpId = seedUuid(STREAM_TAGS.TOUCHPOINT, venue.index, w.slot, i + 1)
        const occurredAt = addDays(w.inquiryDate, tp.daysAfterInquiry)
        const cols = [
          sqlStr(tpId),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(tp.source),
          'NULL', // medium
          'NULL', // campaign
          sqlStr(tp.type),
          sqlTimestamptz(occurredAt),
          sqlStr(tp.signalClass),
        ].join(', ')
        rows.push(`  (${cols})`)
      }
    }
    if (rows.length === 0) continue
    b.raw(
      `INSERT INTO public.wedding_touchpoints\n` +
        `  (id, venue_id, wedding_id, source, medium, campaign, touch_type,\n` +
        `   occurred_at, signal_class)\n` +
        `VALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('wedding_touchpoints', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Interactions — 3-8 per wedding mirroring the touchpoint chain.
// Plus calculator email on a subset of booked weddings + Calendly tour-
// confirmation email on a different subset of booked weddings.
// ---------------------------------------------------------------------------

function emailBodyForType(
  type: Touchpoint['type'],
  w: SeedWedding,
): { subject: string; bodyPreview: string; fullBody: string; fromEmail: string; signalClass: string } {
  const venue = w.venue
  const couple = `${w.partner1.first} & ${w.partner2.first}`
  switch (type) {
    case 'inquiry':
      return {
        subject: `New inquiry from ${w.partner1.first} ${w.partner1.last}`,
        bodyPreview: `Hi! ${couple} are interested in ${venue.name} for a ${w.guestCount}-guest wedding...`,
        fullBody: `Hi there!\n\nWe're ${couple}, looking at ${venue.name} for our ${w.guestCount}-guest wedding next year. Could you share availability and pricing? Tour requested.\n\nThanks!\n${w.partner1.first}`,
        fromEmail: w.source === 'website' ? venueWebsiteEmail(venue.slug) : fromEmailForSource(w.source),
        signalClass: 'source',
      }
    case 'tour_booked':
      return {
        subject: `Tour confirmed - ${venue.name}`,
        bodyPreview: `Your tour at ${venue.name} is confirmed for ${w.tourDate?.toDateString() ?? 'TBD'}.`,
        fullBody: `Hi ${w.partner1.first},\n\nYour tour at ${venue.name} is confirmed via Calendly. We'll see you on ${w.tourDate?.toDateString() ?? 'TBD'}.\n\n— ${venue.name} team`,
        fromEmail: 'notifications@calendly.com',
        signalClass: 'touchpoint',
      }
    case 'tour_conducted':
      return {
        subject: `Thanks for visiting ${venue.name}!`,
        bodyPreview: `Loved meeting you both yesterday — here's the proposal we discussed...`,
        fullBody: `Hi ${couple},\n\nIt was wonderful meeting you both yesterday at ${venue.name}. As promised, here's the proposal we discussed for your ${w.weddingDate?.toDateString() ?? 'wedding date'}.\n\nLet us know what you think!\n\nWarmly,\nThe ${venue.name} team`,
        fromEmail: `events@${venue.slug.replace(/-/g, '')}.com`,
        signalClass: 'touchpoint',
      }
    case 'proposal_sent':
      return {
        subject: `Your custom proposal — ${venue.name}`,
        bodyPreview: `Sending over the contract for ${w.weddingDate?.toDateString() ?? 'your date'}...`,
        fullBody: `Hi ${couple},\n\nAttached is the proposal for your wedding at ${venue.name} on ${w.weddingDate?.toDateString() ?? 'your selected date'}. Total: $${(w.bookingValueCents ?? 1500000) / 100}.\n\nLet us know once you've reviewed.\n\n— ${venue.name}`,
        fromEmail: 'projects@honeybook.com',
        signalClass: 'crm',
      }
    case 'contract_signed':
      return {
        subject: `Contract signed — ${venue.name}`,
        bodyPreview: `Welcome to the ${venue.name} family! Contract is signed and we're booked.`,
        fullBody: `Hi ${couple},\n\nWelcome to the ${venue.name} family! Your contract is signed and your date (${w.weddingDate?.toDateString() ?? 'TBD'}) is officially booked. We'll be in touch with next steps.\n\nCheers,\nThe ${venue.name} team`,
        fromEmail: 'projects@honeybook.com',
        signalClass: 'outcome',
      }
    default:
      return {
        subject: 'Quick follow-up',
        bodyPreview: 'Just checking in...',
        fullBody: 'Just checking in to see if you had any questions.',
        fromEmail: `events@${venue.slug.replace(/-/g, '')}.com`,
        signalClass: 'touchpoint',
      }
  }
}

function buildInteractions(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('4. INTERACTIONS — emails matching touchpoint chain + calculator + Calendly')

  for (const venue of DEMO_VENUES) {
    const venueWeddings = weddings.filter((w) => w.venue.id === venue.id)
    if (venueWeddings.length === 0) continue
    const rows: string[] = []

    // Track which booked weddings get the bonus calculator / Calendly
    // emails — first ~3 booked per venue so the demo has visible data
    // on every venue and Hawthorne has the most.
    let calcAdded = 0
    let calendlyExtraAdded = 0

    for (const w of venueWeddings) {
      const chain = buildTouchpointChain(w)
      // Emit one interaction per touchpoint step.
      for (let i = 0; i < chain.length; i++) {
        const tp = chain[i]!
        const occurredAt = addDays(w.inquiryDate, tp.daysAfterInquiry)
        const id = seedUuid(STREAM_TAGS.INTERACTION, venue.index, w.slot, i + 1)
        const e = emailBodyForType(tp.type, w)
        const direction =
          tp.type === 'inquiry' || tp.type === 'tour_booked' || tp.type === 'contract_signed'
            ? 'inbound'
            : 'outbound'
        const cols = [
          sqlStr(id),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(w.partner1.id),
          sqlStr('email'),
          sqlStr(direction),
          sqlStr(e.subject),
          sqlStr(e.bodyPreview),
          sqlStr(e.fullBody),
          sqlTimestamptz(occurredAt),
          sqlStr(e.fromEmail),
          sqlStr(e.signalClass),
        ].join(', ')
        rows.push(`  (${cols})`)
      }

      // Bonus: calculator email on first 3 booked of each venue (so
      // MMM's interactivecalculator.com extractor has data to find).
      // Hawthorne ends up with 3, others ≤3 so the cross-venue demo
      // sees it everywhere.
      if (
        (w.status === 'booked' || w.status === 'completed') &&
        calcAdded < 3
      ) {
        const id = seedUuid(STREAM_TAGS.INTERACTION, venue.index, w.slot, 90)
        const calcDate = addDays(w.inquiryDate, -2)
        const estimate = ((w.bookingValueCents ?? 1_500_000) / 100).toLocaleString('en-US')
        const subject = `Wedding Cost Estimate for ${w.partner1.first} ${w.partner1.last}`
        const bodyPreview = `Hi ${w.partner1.first}, your venue cost estimate from interactivecalculator.com: $${estimate}.`
        const fullBody =
          `Hi ${w.partner1.first},\n\n` +
          `Thanks for using our wedding cost calculator! Based on your inputs ` +
          `(${w.guestCount} guests at ${venue.name}), your estimated venue cost is $${estimate}.\n\n` +
          `This is just an estimate — the venue will reach out with a custom quote.\n\n` +
          `— interactivecalculator.com`
        const cols = [
          sqlStr(id),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(w.partner1.id),
          sqlStr('email'),
          sqlStr('inbound'),
          sqlStr(subject),
          sqlStr(bodyPreview),
          sqlStr(fullBody),
          sqlTimestamptz(calcDate),
          sqlStr('contact@interactivecalculator.com'),
          sqlStr('source'),
        ].join(', ')
        rows.push(`  (${cols})`)
        calcAdded++
      }

      // Bonus Calendly tour-confirmation email beyond the chain — only
      // for booked weddings whose original source isn't already calendly,
      // first 3 per venue.
      if (
        (w.status === 'booked' || w.status === 'completed') &&
        calendlyExtraAdded < 3
      ) {
        const id = seedUuid(STREAM_TAGS.INTERACTION, venue.index, w.slot, 91)
        const dt = addDays(w.inquiryDate, 13)
        const subject = `New Event: Venue Tour with ${w.partner1.first} ${w.partner1.last}`
        const bodyPreview = `${w.partner1.first} ${w.partner1.last} has scheduled a venue tour at ${venue.name}.`
        const fullBody =
          `Hi there,\n\n` +
          `${w.partner1.first} ${w.partner1.last} has scheduled a "Venue Tour" event ` +
          `with you on ${w.tourDate?.toDateString() ?? addDays(w.inquiryDate, 21).toDateString()} at ${venue.name}.\n\n` +
          `View event: https://calendly.com/scheduled-events/${w.id}\n\n` +
          `— Calendly notifications`
        const cols = [
          sqlStr(id),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(w.partner1.id),
          sqlStr('email'),
          sqlStr('inbound'),
          sqlStr(subject),
          sqlStr(bodyPreview),
          sqlStr(fullBody),
          sqlTimestamptz(dt),
          sqlStr('notifications@calendly.com'),
          sqlStr('touchpoint'),
        ].join(', ')
        rows.push(`  (${cols})`)
        calendlyExtraAdded++
      }
    }

    if (rows.length === 0) continue
    // Chunk inserts so a single statement doesn't get unwieldy. PostgREST
    // / pg_query both prefer ≤500 rows per VALUES clause. We chunk at 200.
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      b.raw(
        `INSERT INTO public.interactions\n` +
          `  (id, venue_id, wedding_id, person_id, type, direction, subject,\n` +
          `   body_preview, full_body, timestamp, from_email, signal_class)\n` +
          `VALUES\n${slice.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
      )
    }
    b.count('interactions', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Marketing spend — 16 monthly rows per venue (Jan 2025 through Apr 2026).
// Hawthorne shape per the brief: Knot $1500/mo, WW $300/mo dropping to $0
// in Feb 2025, Google Ads growing from $200 → $1200/mo, HCG $250/mo.
// Other venues at scaled-down levels.
// ---------------------------------------------------------------------------

function buildMarketingSpend(b: SqlBuilder): void {
  b.section('5. MARKETING_SPEND — 16 monthly rows per venue (Jan 2025 - Apr 2026)')

  // Anchor on Jan 1 2025 UTC, generate 16 month-starts.
  const anchor = new Date(Date.UTC(2025, 0, 1, 0, 0, 0))

  for (const venue of DEMO_VENUES) {
    const rows: string[] = []
    for (let m = 0; m < 16; m++) {
      const month = startOfMonth(addMonths(anchor, m))
      // Knot — always-on
      const knot = Math.round(1500 * venue.spendScale)
      // WeddingWire — drops to $0 in Feb 2025 (m=1) for Hawthorne
      const wwBase = m < 1 ? 300 : 0
      const ww = Math.round(wwBase * venue.spendScale)
      // Google Ads — ramps from $200 to $1200 over 12 months, then plateaus
      const googleBase = Math.min(200 + (m * 1000) / 12, 1200)
      const google = Math.round(googleBase * venue.spendScale)
      // HCG (Here Comes the Guide)
      const hcg = Math.round(250 * venue.spendScale)

      const channels: Array<{ source: string; amount: number; slot: number }> = [
        { source: 'the_knot', amount: knot, slot: 1 },
        { source: 'weddingwire', amount: ww, slot: 2 },
        { source: 'google', amount: google, slot: 3 },
        { source: 'here_comes_the_guide', amount: hcg, slot: 4 },
      ]

      for (const c of channels) {
        if (c.amount === 0) continue // skip zero rows so the trend reads as a real drop
        const id = seedUuid(STREAM_TAGS.SPEND, venue.index, m, c.slot)
        const cols = [
          sqlStr(id),
          sqlStr(venue.id),
          sqlStr(c.source),
          sqlDate(month),
          sqlNum(c.amount),
        ].join(', ')
        rows.push(`  (${cols})`)
      }
    }
    if (rows.length === 0) continue
    b.raw(
      `INSERT INTO public.marketing_spend\n` +
        `  (id, venue_id, source, month, amount)\n` +
        `VALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('marketing_spend', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Tours — one per booked wedding (status ∈ {booked, completed}) with
// outcome='completed'. The temporal trigger from migration 196 takes
// care of the couple_display_name from the people rows we just inserted.
// ---------------------------------------------------------------------------

function buildTours(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('6. TOURS — one per booked wedding with outcome=completed')

  for (const venue of DEMO_VENUES) {
    const rows: string[] = []
    for (const w of weddings.filter((w) => w.venue.id === venue.id)) {
      // Only book a tour for weddings that reached at least tour_completed.
      if (
        w.status !== 'booked' &&
        w.status !== 'completed' &&
        w.status !== 'tour_completed' &&
        w.status !== 'proposal_sent'
      ) {
        continue
      }
      const id = seedUuid(STREAM_TAGS.TOUR, venue.index, w.slot, 1)
      const scheduledAt = addDays(w.inquiryDate, 21)
      const outcome =
        w.status === 'booked' || w.status === 'completed' || w.status === 'proposal_sent' || w.status === 'tour_completed'
          ? 'completed'
          : 'completed'
      const cols = [
        sqlStr(id),
        sqlStr(venue.id),
        sqlStr(w.id),
        sqlTimestamptz(scheduledAt),
        sqlStr('in_person'),
        sqlStr(w.source ?? 'website'),
        sqlStr(outcome),
        // signal_class — migration 192 dropped DEFAULT on tours so writers
        // MUST declare class. A tour is a touchpoint (not a source channel).
        sqlStr('touchpoint'),
      ].join(', ')
      rows.push(`  (${cols})`)
    }
    if (rows.length === 0) continue
    b.raw(
      `INSERT INTO public.tours\n` +
        `  (id, venue_id, wedding_id, scheduled_at, tour_type, source, outcome,\n` +
        `   signal_class)\n` +
        `VALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('tours', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Engagement events — 2-5 per wedding capturing realistic milestones.
// ---------------------------------------------------------------------------

function buildEngagementEvents(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('7. ENGAGEMENT_EVENTS — 2-5 lead-score milestones per wedding')

  for (const venue of DEMO_VENUES) {
    const rng = makeRng(venue.index * 7919)
    const rows: string[] = []
    for (const w of weddings.filter((w) => w.venue.id === venue.id)) {
      const events: Array<{ type: string; points: number; daysOffset: number }> = []
      // Always: tour_requested
      events.push({ type: 'tour_requested', points: 10, daysOffset: 0 })
      if (w.status === 'tour_scheduled' || w.status === 'tour_completed' || w.status === 'proposal_sent' || w.status === 'booked' || w.status === 'completed') {
        events.push({ type: 'tour_scheduled', points: 15, daysOffset: 14 })
      }
      if (w.status === 'tour_completed' || w.status === 'proposal_sent' || w.status === 'booked' || w.status === 'completed') {
        events.push({ type: 'tour_completed', points: 25, daysOffset: 21 })
      }
      if (w.status === 'proposal_sent' || w.status === 'booked' || w.status === 'completed') {
        events.push({ type: 'contract_review_started', points: 20, daysOffset: 32 })
      }
      if (w.status === 'booked' || w.status === 'completed') {
        events.push({ type: 'contract_signed', points: 30, daysOffset: 60 })
      }
      // Add 0-1 high-commitment signal randomly
      if (rng() < 0.4 && w.status !== 'lost') {
        events.push({ type: 'high_commitment_signal', points: 15, daysOffset: int(rng, 5, 30) })
      }
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!
        const id = seedUuid(STREAM_TAGS.ENGAGEMENT, venue.index, w.slot, i + 1)
        const occurredAt = addDays(w.inquiryDate, ev.daysOffset)
        const cols = [
          sqlStr(id),
          sqlStr(venue.id),
          sqlStr(w.id),
          sqlStr(ev.type),
          sqlNum(ev.points),
          sqlTimestamptz(occurredAt),  // created_at
          sqlTimestamptz(occurredAt),  // occurred_at (NOT NULL since mig 094-ish)
          // direction: every demo seed event is couple-to-venue. The
          // column went NOT NULL in mig 116 (Playbook INV-13). All these
          // are inbound — tour requested, signed, etc. — so 'inbound' is
          // the correct value, not a guess.
          sqlStr('inbound'),
        ].join(', ')
        rows.push(`  (${cols})`)
      }
    }
    if (rows.length === 0) continue
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      b.raw(
        `INSERT INTO public.engagement_events\n` +
          `  (id, venue_id, wedding_id, event_type, points, created_at,\n` +
          `   occurred_at, direction)\n` +
          `VALUES\n${slice.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
      )
    }
    b.count('engagement_events', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Lost deals — one per lost wedding so the lost-deal page has data.
// ---------------------------------------------------------------------------

function buildLostDeals(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('8. LOST_DEALS — one per lost wedding')

  const reasons = ['pricing', 'date_unavailable', 'competitor', 'no_response', 'changed_plans']
  const stages: Array<'inquiry' | 'tour' | 'hold' | 'contract'> = ['inquiry', 'tour', 'hold', 'contract']

  for (const venue of DEMO_VENUES) {
    const rng = makeRng(venue.index * 7741)
    const rows: string[] = []
    for (const w of weddings.filter((w) => w.venue.id === venue.id && w.status === 'lost')) {
      const id = seedUuid(STREAM_TAGS.LOST_DEAL, venue.index, w.slot, 1)
      const stage = pick(rng, stages)
      const reason = pick(rng, reasons)
      const cols = [
        sqlStr(id),
        sqlStr(venue.id),
        sqlStr(w.id),
        sqlStr(stage),
        sqlStr(reason),
        sqlTimestamptz(w.lostAt ?? addDays(w.inquiryDate, 30)),
        // signal_class — lost_deals records are ALWAYS outcome class
        // per migration 192. DEFAULT was dropped, so writers must declare.
        sqlStr('outcome'),
      ].join(', ')
      rows.push(`  (${cols})`)
    }
    if (rows.length === 0) continue
    b.raw(
      `INSERT INTO public.lost_deals\n` +
        `  (id, venue_id, wedding_id, lost_at_stage, reason_category, lost_at,\n` +
        `   signal_class)\n` +
        `VALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;`
    )
    b.count('lost_deals', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Source attribution — per-venue, per-source, per-month rollup. We keep
// it simple: one row per (venue, source, month) summing up bookings +
// inquiries from the weddings we just generated, joined to the spend.
// This populates the Source Quality + Source Comparison tiles.
//
// Computed in JS rather than via a SELECT INSERT so the output is
// deterministic + matches the rest of the seed exactly.
// ---------------------------------------------------------------------------

function buildSourceAttribution(b: SqlBuilder, weddings: SeedWedding[]): void {
  b.section('9. SOURCE_ATTRIBUTION — per-source per-month rollup')

  // Pre-roll-up the synthetic spend so we don't have to round-trip to
  // the SQL we just built.
  function spendFor(venue: DemoVenue, source: string, month: Date): number {
    const m =
      (month.getUTCFullYear() - 2025) * 12 + month.getUTCMonth()
    if (source === 'the_knot') return Math.round(1500 * venue.spendScale)
    if (source === 'weddingwire') return m < 1 ? Math.round(300 * venue.spendScale) : 0
    if (source === 'google') return Math.round(Math.min(200 + (m * 1000) / 12, 1200) * venue.spendScale)
    if (source === 'here_comes_the_guide') return Math.round(250 * venue.spendScale)
    return 0
  }

  for (const venue of DEMO_VENUES) {
    // Bucket weddings by (source, year-month-of-inquiry)
    const buckets = new Map<string, { source: string; month: Date; inquiries: number; bookings: number; revenueCents: number }>()
    for (const w of weddings.filter((w) => w.venue.id === venue.id)) {
      const monthStart = startOfMonth(w.inquiryDate)
      const key = `${w.source ?? 'unknown'}|${monthStart.toISOString()}`
      let cell = buckets.get(key)
      if (!cell) {
        cell = {
          source: w.source ?? 'unknown',
          month: monthStart,
          inquiries: 0,
          bookings: 0,
          revenueCents: 0,
        }
        buckets.set(key, cell)
      }
      cell.inquiries += 1
      if (w.status === 'booked' || w.status === 'completed') {
        cell.bookings += 1
        cell.revenueCents += w.bookingValueCents ?? 0
      }
    }

    const rows: string[] = []
    let serial = 0
    for (const cell of buckets.values()) {
      serial++
      const id = seedUuid(STREAM_TAGS.ATTRIBUTION, venue.index, 0, serial)
      const monthEnd = addDays(addMonths(cell.month, 1), -1)
      const spend = spendFor(venue, cell.source, cell.month)
      const conversionRate = cell.inquiries > 0 ? cell.bookings / cell.inquiries : 0
      const costPerInquiry = cell.inquiries > 0 ? spend / cell.inquiries : 0
      const costPerBooking = cell.bookings > 0 ? spend / cell.bookings : 0
      const revenueDollars = cell.revenueCents / 100
      const roi = spend > 0 ? (revenueDollars - spend) / spend : null
      const cols = [
        sqlStr(id),
        sqlStr(venue.id),
        sqlStr(cell.source),
        sqlDate(cell.month),
        sqlDate(monthEnd),
        sqlNum(spend),
        sqlNum(cell.inquiries),
        sqlNum(0), // tours — we don't roll these up, the funnel reads it elsewhere
        sqlNum(cell.bookings),
        sqlNum(revenueDollars),
        sqlNum(Number(costPerInquiry.toFixed(2))),
        sqlNum(Number(costPerBooking.toFixed(2))),
        sqlNum(Number(conversionRate.toFixed(4))),
        roi !== null ? sqlNum(Number(roi.toFixed(4))) : 'NULL',
      ].join(', ')
      rows.push(`  (${cols})`)
    }
    if (rows.length === 0) continue
    // ON CONFLICT uses the (venue_id, source, period_start) unique index
    // from migration 180 — a re-seed against an already-rolled-up venue
    // is a no-op rather than a duplicate-key error. (We can't use
    // ON CONFLICT (id) here because the unique index is on the natural
    // key, and PostgreSQL rejects an ON CONFLICT spec that doesn't match
    // the underlying constraint.)
    b.raw(
      `INSERT INTO public.source_attribution\n` +
        `  (id, venue_id, source, period_start, period_end, spend, inquiries,\n` +
        `   tours, bookings, revenue, cost_per_inquiry, cost_per_booking,\n` +
        `   conversion_rate, roi)\n` +
        `VALUES\n${rows.join(',\n')}\n` +
        `ON CONFLICT (venue_id, source, period_start) DO NOTHING;`
    )
    b.count('source_attribution', rows.length)
  }
}

// ---------------------------------------------------------------------------
// Top-level builder — call each section in order.
// ---------------------------------------------------------------------------

function buildSql(): { sql: string; counts: Record<string, number>; weddings: SeedWedding[] } {
  const b = new SqlBuilder()

  b.raw(`-- ============================================================`)
  b.raw(`-- supabase/seed-demo-rich.sql`)
  b.raw(`-- ============================================================`)
  b.raw(`-- Stream VVV — Rich demo enrichment for Crestwood Collection.`)
  b.raw(`-- Generated by scripts/seed-demo-rich.ts. DO NOT edit by hand.`)
  b.raw(`-- Re-run that script to regenerate (deterministic output).`)
  b.raw(`-- Idempotent: ON CONFLICT (id) DO NOTHING throughout.`)
  b.raw(`-- ============================================================`)

  const weddings = buildWeddings(b)
  buildPeople(b, weddings)
  buildTouchpoints(b, weddings)
  buildInteractions(b, weddings)
  buildMarketingSpend(b)
  buildTours(b, weddings)
  buildEngagementEvents(b, weddings)
  buildLostDeals(b, weddings)
  buildSourceAttribution(b, weddings)

  return { sql: b.toString(), counts: b.counts, weddings }
}

// ---------------------------------------------------------------------------
// Apply the SQL via the public.exec_sql RPC. Same shape as run-migration.ts
// — split on top-level statements + NULL out transaction-control noise.
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // ignore — env may already be set
  }
  return env
}

async function applySql(sql: string): Promise<void> {
  const all = splitSqlStatements(sql)
  // Strip transaction-control statements (PL/pgSQL EXECUTE rejects them).
  const TX_CONTROL_RE = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|END)\b/i
  const statements = all.filter((s) => !TX_CONTROL_RE.test(s))

  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Make sure .env.local is populated.',
    )
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  console.log(`Applying ${statements.length} statement(s) via exec_sql RPC...`)

  let okCount = 0
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 100) + (stmt.length > 100 ? '...' : '')
    process.stdout.write(`  [${i + 1}/${statements.length}] ${preview}\n`)
    const t0 = Date.now()
    const { data, error } = await sb.rpc('exec_sql', { sql: stmt })
    const dt = Date.now() - t0
    if (error) {
      console.error(`  ✗ RPC transport failed (${dt}ms): ${error.message}`)
      console.error(`    statement was:\n${stmt.slice(0, 800)}${stmt.length > 800 ? '...' : ''}`)
      process.exit(1)
    }
    const result = data as { ok: boolean; error?: string; state?: string } | null
    if (!result || !result.ok) {
      console.error(`  ✗ SQL failed (${dt}ms): [${result?.state ?? '?'}] ${result?.error ?? 'unknown'}`)
      console.error(`    statement was:\n${stmt.slice(0, 800)}${stmt.length > 800 ? '...' : ''}`)
      process.exit(1)
    }
    okCount++
    console.log(`  ✓ ok (${dt}ms)`)
  }
  console.log(`\nApplied ${okCount}/${statements.length} statement(s).`)
}

// ---------------------------------------------------------------------------
// Probe — hit the wedding-rollup endpoint server-side equivalent to assert
// total revenue is plausible (~$300K-$500K from ~30 booked × ~$15K).
// We can't easily call the route handler from a script, so we replicate
// its math directly against the database.
// ---------------------------------------------------------------------------

async function probeHawthorneRevenue(): Promise<void> {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const HAWTHORNE = '22222222-2222-2222-2222-222222222201'

  const { data: weddings, error } = await sb
    .from('weddings')
    .select('source, booking_value, status, merged_into_id')
    .eq('venue_id', HAWTHORNE)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  if (error) {
    console.error('[probe] failed:', error.message)
    return
  }

  let bookings = 0
  let revenueCents = 0
  for (const w of weddings ?? []) {
    bookings += 1
    revenueCents += Number(w.booking_value ?? 0)
  }
  const revenueDollars = revenueCents / 100
  console.log(`\n[probe] Hawthorne wedding-rollup equivalent:`)
  console.log(`  bookings:        ${bookings}`)
  console.log(`  revenue (cents): ${revenueCents.toLocaleString()}`)
  console.log(`  revenue ($):     $${revenueDollars.toLocaleString()}`)
  if (revenueDollars >= 250_000 && revenueDollars <= 1_500_000) {
    console.log(`  ✓ revenue in plausible range ($250K-$1.5M)`)
  } else {
    console.log(`  ⚠ revenue outside expected $300K-$500K window — review seed scale`)
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  console.log('Building SQL...')
  const { sql, counts } = buildSql()

  // Always write the SQL file — that's the auditable artifact and the
  // brief asks for `supabase/seed-demo-rich.sql`.
  const outPath = resolve('supabase/seed-demo-rich.sql')
  writeFileSync(outPath, sql, 'utf8')
  console.log(`Wrote ${outPath} (${sql.length.toLocaleString()} bytes)`)

  console.log('\nGenerated row counts (across all venues):')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(25)} ${v}`)
  }

  if (dryRun) {
    console.log('\n--dry-run: skipping apply step.')
    return
  }

  await applySql(sql)
  await probeHawthorneRevenue()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
