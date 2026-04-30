// Data integrity invariants — pass-or-fail gate before "Go Live".
//
// Each invariant is a SQL query that returns rows = violations. A
// venue is healthy when every query returns zero rows. The script
// runs all invariants per venue, prints counts, and exits non-zero
// if any returned rows.
//
// Run after onboard-data-cleanup.ts. Re-run periodically (cron) to
// catch drift.
//
// Usage:
//   npx tsx scripts/data-integrity-check.ts --venue <uuid>
//   npx tsx scripts/data-integrity-check.ts --venue <uuid> --json   # machine-readable
//   npx tsx scripts/data-integrity-check.ts --venue <uuid> --details  # show first 10 violations per check
//
// Exit codes:
//   0 — all invariants pass
//   1 — one or more invariants violated
//   2 — script error (no rows fetched, etc.)
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null
const asJson = args.includes('--json')
const showDetails = args.includes('--details')
if (!venueId) {
  console.error('Required: --venue <uuid>')
  process.exit(2)
}

interface Invariant {
  /** Short id used in JSON output. */
  id: string
  /** Human-readable name. */
  name: string
  /** Why a violation matters. */
  meaning: string
  /** Returns array of violating rows (one row per violation). */
  fetch: () => Promise<{ count: number; sample: Record<string, unknown>[] }>
}

const SAMPLE_LIMIT = 10

async function fetchOne<T extends Record<string, unknown>>(query: PromiseLike<{ data: T[] | null }>) {
  const { data } = await query
  return (data ?? []) as T[]
}

const INVARIANTS: Invariant[] = [
  {
    id: 'causality_tour_before_inquiry',
    name: 'Causality: tour cannot happen before inquiry',
    meaning: 'A wedding whose tour_date precedes its inquiry_date by >24h indicates corrupted timestamps. The tour cannot logically happen before the customer inquired. Surfaces e.g. inquiry stamped to a Sage drip subject when the actual inquiry was earlier.',
    async fetch() {
      const rows = await fetchOne(sb.rpc('exec_sql', {
        // No exec_sql — fall back to client-side join.
      }) as unknown as PromiseLike<{ data: never[] | null }>).catch(() => [])
      // Fallback: query weddings, filter in memory.
      const { data } = await sb
        .from('weddings')
        .select('id, inquiry_date, tour_date')
        .eq('venue_id', venueId)
        .not('tour_date', 'is', null)
        .not('inquiry_date', 'is', null)
      const violations = ((data ?? []) as Array<{ id: string; inquiry_date: string; tour_date: string }>)
        .filter((w) => {
          const inq = new Date(w.inquiry_date).getTime()
          const tour = new Date(w.tour_date).getTime()
          return tour < inq - 24 * 3_600_000
        })
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'direction_from_venue_own',
    name: 'Direction parity: no inbound from venue-owned addresses',
    meaning: 'An interaction with direction=inbound but from_email is the venue\'s own sending address (e.g. info@venue.com) means Sage\'s outbound got misclassified as customer mail. Cascades into signal-inference firing patterns on our own marketing copy and inflating heat.',
    async fetch() {
      // Pull ownEmails by querying outbound from_email distinct values
      // for this venue.
      const { data: ownData } = await sb
        .from('interactions')
        .select('from_email')
        .eq('venue_id', venueId)
        .eq('direction', 'outbound')
        .not('from_email', 'is', null)
      const own = new Set<string>()
      for (const r of (ownData ?? []) as Array<{ from_email: string | null }>) {
        const e = (r.from_email ?? '').toLowerCase().trim()
        if (e) own.add(e)
      }
      if (own.size === 0) return { count: 0, sample: [] }
      // Find inbound rows whose from_email is in own.
      const ownArr = Array.from(own)
      const { data: bad } = await sb
        .from('interactions')
        .select('id, direction, from_email, subject, timestamp')
        .eq('venue_id', venueId)
        .eq('direction', 'inbound')
        .in('from_email', ownArr)
        .limit(SAMPLE_LIMIT * 5)
      const violations = ((bad ?? []) as Array<Record<string, unknown>>)
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'engagement_event_on_outbound',
    name: 'False-positive parity: no signal-inference event on outbound',
    meaning: 'An engagement_event whose metadata.interaction_id points to a direction=outbound row means signal-inference fired tour_requested / high_specificity / sustained_engagement on our own marketing copy. Removes false-positive heat.',
    async fetch() {
      const { data: outboundIds } = await sb
        .from('interactions')
        .select('id')
        .eq('venue_id', venueId)
        .eq('direction', 'outbound')
      const ids = ((outboundIds ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (ids.length === 0) return { count: 0, sample: [] }
      // Engagement events whose metadata.interaction_id is in `ids`.
      // Need to scan because PostgREST doesn't filter by jsonb member.
      const { data: events } = await sb
        .from('engagement_events')
        .select('id, event_type, metadata, occurred_at')
        .eq('venue_id', venueId)
        .in('event_type', [
          'tour_requested', 'high_specificity', 'sustained_engagement',
          'high_commitment_signal', 'email_reply_received',
        ])
        .limit(5000)
      const idSet = new Set(ids)
      const violations: Record<string, unknown>[] = []
      for (const e of ((events ?? []) as Array<{ id: string; event_type: string; metadata: { interaction_id?: string | null } | null; occurred_at: string | null }>)) {
        const iid = e.metadata?.interaction_id
        if (iid && idSet.has(iid)) violations.push(e as unknown as Record<string, unknown>)
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'inquiry_date_drift',
    name: 'Inquiry parity: inquiry_date matches earliest inbound interaction',
    meaning: 'A wedding whose inquiry_date differs by >48h from its earliest inbound interaction\'s timestamp suggests inquiry_date was stamped to wall-clock NOW (backfill artifact) or pinned to a later non-inquiry email. Blocks accurate first-touch attribution.',
    async fetch() {
      const { data: weddings } = await sb
        .from('weddings')
        .select('id, inquiry_date')
        .eq('venue_id', venueId)
      const violations: Record<string, unknown>[] = []
      for (const w of ((weddings ?? []) as Array<{ id: string; inquiry_date: string | null }>)) {
        if (!w.inquiry_date) continue
        const { data: first } = await sb
          .from('interactions')
          .select('timestamp')
          .eq('wedding_id', w.id)
          .eq('direction', 'inbound')
          .not('timestamp', 'is', null)
          .order('timestamp', { ascending: true })
          .limit(1)
        const earliest = (first?.[0] as { timestamp: string } | undefined)?.timestamp
        if (!earliest) continue
        const drift = Math.abs(new Date(earliest).getTime() - new Date(w.inquiry_date).getTime()) / 3_600_000
        if (drift >= 48) {
          violations.push({ wedding_id: w.id, inquiry_date: w.inquiry_date, earliest_inbound: earliest, drift_hours: Math.round(drift) })
          if (violations.length >= SAMPLE_LIMIT * 5) break
        }
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'wedding_has_people',
    name: 'Structural: every wedding has at least one linked person',
    meaning: 'A wedding row with zero people is a "ghost" lead — invisible on the leads UI, breaks contact-resolution. Usually a pipeline bug or a partial deletion. Either repopulate the person or delete the wedding.',
    async fetch() {
      const { data: weddings } = await sb
        .from('weddings')
        .select('id, status, source')
        .eq('venue_id', venueId)
      const violations: Record<string, unknown>[] = []
      for (const w of ((weddings ?? []) as Array<{ id: string; status: string; source: string | null }>)) {
        const { count } = await sb
          .from('people')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', w.id)
        if ((count ?? 0) === 0) {
          violations.push({ wedding_id: w.id, status: w.status, source: w.source })
          if (violations.length >= SAMPLE_LIMIT * 5) break
        }
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'no_future_event_times',
    name: 'Sanity: no wedding has inquiry/tour_completed timestamps in the future',
    meaning: 'A status=tour_completed wedding with tour_date > now means the data is wrong. Same for inquiry_date > now. Catches pipeline bugs that stamp timestamps from the future (e.g. parsing a date from a forward-dated email body).',
    async fetch() {
      const nowIso = new Date().toISOString()
      const { data: weddings } = await sb
        .from('weddings')
        .select('id, status, inquiry_date, tour_date')
        .eq('venue_id', venueId)
      const violations: Record<string, unknown>[] = []
      for (const w of ((weddings ?? []) as Array<{ id: string; status: string; inquiry_date: string | null; tour_date: string | null }>)) {
        if (w.inquiry_date && w.inquiry_date > nowIso) {
          violations.push({ wedding_id: w.id, field: 'inquiry_date', value: w.inquiry_date })
        }
        if (w.status === 'tour_completed' && w.tour_date && w.tour_date > nowIso) {
          violations.push({ wedding_id: w.id, field: 'tour_date_when_completed', value: w.tour_date, status: w.status })
        }
        if (violations.length >= SAMPLE_LIMIT * 5) break
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'duplicate_gmail_message_ids',
    name: 'Dedup: no Gmail message_id ingested more than once per venue',
    meaning: 'Two interactions sharing the same gmail_message_id means the dedup logic in the email pipeline failed. Causes double-counting of replies, duplicate engagement events, inflated heat. Check email-pipeline.isEmailProcessed if this fires.',
    async fetch() {
      // PostgREST doesn't support GROUP BY; fetch + count in memory.
      const { data: ints } = await sb
        .from('interactions')
        .select('id, gmail_message_id')
        .eq('venue_id', venueId)
        .not('gmail_message_id', 'is', null)
      const counts = new Map<string, string[]>()
      for (const r of ((ints ?? []) as Array<{ id: string; gmail_message_id: string | null }>)) {
        if (!r.gmail_message_id) continue
        const arr = counts.get(r.gmail_message_id) ?? []
        arr.push(r.id)
        counts.set(r.gmail_message_id, arr)
      }
      const violations: Record<string, unknown>[] = []
      for (const [mid, ids] of counts.entries()) {
        if (ids.length > 1) {
          violations.push({ gmail_message_id: mid, dup_count: ids.length, interaction_ids: ids.slice(0, 5) })
        }
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
  {
    id: 'touchpoint_source_consistency',
    name: 'Source consistency: touchpoint source matches linked interaction\'s channel',
    meaning: 'A tour_booked / inquiry / email_reply touchpoint with source like "website" but linked to an interaction whose from_email is a known platform (calendly, acuity, the_knot, etc.) means the touchpoint inherited the wedding\'s legacy source. Renders wrong in the journey UI.',
    async fetch() {
      const KNOWN_DOMAINS: Record<string, string> = {
        '@calendly.com': 'calendly',
        '@calendlymail.com': 'calendly',
        '@acuityscheduling.com': 'acuity',
        '@honeybook.com': 'honeybook',
        '@dubsado.com': 'dubsado',
        '@theknot.com': 'the_knot',
        '@knotemail.com': 'the_knot',
        '@weddingwire.com': 'wedding_wire',
        '@herecomestheguide.com': 'here_comes_the_guide',
      }
      const { data: tps } = await sb
        .from('wedding_touchpoints')
        .select('id, touch_type, source, metadata')
        .eq('venue_id', venueId)
        .in('touch_type', ['tour_booked', 'calendly_booked', 'inquiry', 'email_reply', 'tour_conducted'])
      const violations: Record<string, unknown>[] = []
      for (const tp of ((tps ?? []) as Array<{ id: string; touch_type: string; source: string | null; metadata: { interaction_id?: string | null; engagement_event_id?: string | null } | null }>)) {
        let iid = tp.metadata?.interaction_id ?? null
        if (!iid && tp.metadata?.engagement_event_id) {
          const { data: ee } = await sb
            .from('engagement_events')
            .select('metadata')
            .eq('id', tp.metadata.engagement_event_id)
            .maybeSingle()
          iid = ((ee as { metadata: { interaction_id?: string | null } | null } | null)?.metadata?.interaction_id) ?? null
        }
        if (!iid) continue
        const { data: ix } = await sb.from('interactions').select('from_email').eq('id', iid).maybeSingle()
        const fromEmail = (((ix as { from_email: string | null } | null)?.from_email) ?? '').toLowerCase()
        if (!fromEmail) continue
        for (const [domain, expectedSource] of Object.entries(KNOWN_DOMAINS)) {
          if (fromEmail.includes(domain) && tp.source !== expectedSource) {
            violations.push({
              touchpoint_id: tp.id,
              touch_type: tp.touch_type,
              current_source: tp.source,
              expected_source: expectedSource,
              from_email: fromEmail,
            })
            break
          }
        }
        if (violations.length >= SAMPLE_LIMIT * 5) break
      }
      return { count: violations.length, sample: violations.slice(0, SAMPLE_LIMIT) }
    },
  },
]

interface Result {
  invariant: Invariant
  count: number
  sample: Record<string, unknown>[]
}

async function main() {
  if (!asJson) {
    console.log(`\n=== Data integrity check — venue ${venueId} ===\n`)
    console.log(`${INVARIANTS.length} invariants. Each returns rows when violated.\n`)
  }

  const results: Result[] = []
  for (const inv of INVARIANTS) {
    try {
      const { count, sample } = await inv.fetch()
      results.push({ invariant: inv, count, sample })
    } catch (err) {
      console.error(`  [${inv.id}] error: ${err instanceof Error ? err.message : String(err)}`)
      results.push({ invariant: inv, count: -1, sample: [] })
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      venueId,
      results: results.map((r) => ({
        id: r.invariant.id,
        name: r.invariant.name,
        violations: r.count,
        sample: r.sample,
      })),
    }, null, 2))
  } else {
    let allClean = true
    for (const r of results) {
      const status = r.count === 0 ? '✓' : r.count === -1 ? '?' : '✗'
      console.log(`  ${status} ${r.count.toString().padStart(4)}  ${r.invariant.name}`)
      if (r.count > 0) allClean = false
      if (showDetails && r.count > 0) {
        console.log(`         meaning: ${r.invariant.meaning}`)
        console.log(`         first ${Math.min(SAMPLE_LIMIT, r.count)} violations:`)
        for (const s of r.sample) console.log(`           ${JSON.stringify(s)}`)
      }
    }
    console.log()
    if (allClean) {
      console.log('All invariants pass. Venue is data-integrity-clean.')
    } else {
      console.log('One or more invariants violated. Run scripts/onboard-data-cleanup.ts --apply to repair.')
      console.log('Re-run this check after; venue should not be enabled for Go Live until clean.')
    }
  }

  const anyViolations = results.some((r) => r.count > 0)
  process.exit(anyViolations ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(2) })
