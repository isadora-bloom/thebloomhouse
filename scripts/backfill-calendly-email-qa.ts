/**
 * Backfill weddings.calendly_qa + discovery_sources from Calendly
 * notification emails sitting in `interactions`.
 *
 * Why this exists
 * ---------------
 * The Calendly webhook (src/app/api/webhooks/calendly/route.ts) is the
 * intended writer of weddings.calendly_qa + discovery_sources, but it has
 * never fired in Rixey prod (no live webhook subscription) — calendly_qa is
 * NULL on every wedding and discovery_sources is essentially empty. BUT
 * every booking generated a "New Event: …" notification email that IS synced
 * into `interactions.full_body`, containing the full invitee Q&A in plain
 * text:
 *
 *   Questions:
 *   Partners First and Last Name
 *   Julie Cruz
 *   Partners Email
 *   juliecruz715@gmail.com
 *   Phone number
 *   5408495278
 *   ...Do you have an approximate date in mind?
 *   July 17th weekend of 2027
 *   Do you have a number of invited guests in mind?
 *   12-80
 *   Where did you hear about us?
 *   <answer>
 *
 * This script parses those bodies and writes:
 *   1. weddings.calendly_qa  — merged under an `email_parsed` key (never
 *      clobbers webhook_* data if the webhook later starts firing).
 *   2. discovery_sources + attribution_events — for the "Where did you
 *      hear about us?" answer, using the canonical mapper from
 *      src/lib/services/discovery-source/canonical.ts (the SAME mapping
 *      the live capture writer uses).
 *
 * It deliberately does NOT write partner names/emails into people/couples —
 * that goes through the name-evidence chokepoint, not a batch script. The
 * partner2 fields are captured into calendly_qa (a safe structured column)
 * and reported, so the operator / resolver can promote them deliberately.
 *
 * It also does NOT fire the forwards-linker cascade (capture.ts does) — a
 * blind batch over hundreds of rows should not pull the full identity
 * cascade. discovery_sources rows can be re-fanned by the live capture path
 * later. This is noted in the summary.
 *
 * Usage:
 *   npx tsx scripts/backfill-calendly-email-qa.ts            # dry-run (default)
 *   npx tsx scripts/backfill-calendly-email-qa.ts --apply    # write
 *   npx tsx scripts/backfill-calendly-email-qa.ts --limit 5  # sample N
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mapWithRule } from '@/lib/services/discovery-source/canonical'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) || 0 : 0
const CAPTURE_SOURCE = 'calendly_email'

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const STOP_MARKERS = [
  'View event in Calendly',
  'Pro Tip!',
  'Use Calendly with your other tools',
  'See all integrations',
  'Sent from Calendly',
  'Report this event',
  'Cancel',
  'Reschedule',
]

// A block line is a QUESTION (vs an answer) when it matches one of these.
const QUESTION_HINTS: RegExp[] = [
  /first and last name/i,
  /partner'?s?\s+(first|last|email|name|phone)/i,
  /^phone number$/i,
  /^text reminder number$/i,
  /approximate date|specific date|date in mind/i,
  /number of (invited )?guests|guest count|guests in mind/i,
  /where did you (hear|find)/i,
  /how did you (hear|find)/i,
  /\?\s*$/, // anything ending in a question mark
]

function isQuestionLine(line: string): boolean {
  return QUESTION_HINTS.some((re) => re.test(line))
}

interface ParsedEmail {
  inviteeName: string | null
  inviteeEmail: string | null
  eventType: string | null
  eventDateTime: string | null
  pairs: Array<{ question: string; answer: string }>
  flattened: Record<string, string>
}

function valueAfterLabel(lines: string[], label: string): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase() === label.toLowerCase()) {
      // next non-empty line is the value
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return lines[j].trim()
      }
    }
  }
  return null
}

function parseEmail(rawBody: string): ParsedEmail | null {
  if (!rawBody) return null
  const lines = rawBody
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const inviteeName = valueAfterLabel(lines, 'Invitee:')
  const inviteeEmail = valueAfterLabel(lines, 'Invitee Email:')
  const eventType = valueAfterLabel(lines, 'Event Type:')
  const eventDateTime = valueAfterLabel(lines, 'Event Date/Time:')

  // Locate the Questions block.
  const qIdx = lines.findIndex((l) => /^questions:?$/i.test(l))
  const pairs: Array<{ question: string; answer: string }> = []
  if (qIdx >= 0) {
    let end = lines.length
    for (let i = qIdx + 1; i < lines.length; i++) {
      if (STOP_MARKERS.some((m) => lines[i].toLowerCase().startsWith(m.toLowerCase()))) {
        end = i
        break
      }
    }
    const block = lines.slice(qIdx + 1, end)
    let curQ: string | null = null
    let curA: string[] = []
    const flush = () => {
      if (curQ != null) {
        const ans = curA.join(' ').trim()
        if (ans) pairs.push({ question: curQ, answer: ans })
      }
    }
    for (const line of block) {
      if (isQuestionLine(line)) {
        flush()
        curQ = line
        curA = []
      } else if (curQ != null) {
        curA.push(line)
      }
      // lines before the first question are ignored
    }
    flush()
  }

  const flattened: Record<string, string> = {}
  for (const p of pairs) flattened[p.question] = p.answer

  if (!inviteeEmail && pairs.length === 0) return null
  return { inviteeName, inviteeEmail, eventType, eventDateTime, pairs, flattened }
}

// Pull the discovery answer ("Where did you hear/find...") from parsed pairs.
function discoveryAnswerOf(parsed: ParsedEmail): { q: string; a: string } | null {
  for (const p of parsed.pairs) {
    if (/where did you (hear|find)|how did you (hear|find)/i.test(p.question)) {
      if (p.answer && p.answer.trim()) return { q: p.question, a: p.answer.trim() }
    }
  }
  return null
}

// Pull partner2 convenience fields for calendly_qa (NOT written to people).
function partnerFieldsOf(parsed: ParsedEmail) {
  const f = parsed.flattened
  const find = (re: RegExp) => {
    for (const [q, a] of Object.entries(f)) if (re.test(q)) return a
    return null
  }
  return {
    partner2_name: find(/partner'?s?\s+(first|last)?\s*and?\s*last\s*name|partner'?s?\s+name/i),
    partner2_email: find(/partner'?s?\s+email/i),
    partner2_phone: find(/partner'?s?\s+phone/i),
    phone: find(/^phone number$/i),
    guest_count: find(/number of (invited )?guests|guest count|guests in mind/i),
    date_preference: find(/approximate date|specific date|date in mind/i),
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

async function fetchCalendlyEmails() {
  const out: any[] = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb
      .from('interactions')
      .select('id,wedding_id,person_id,subject,from_email,timestamp,full_body,gmail_message_id')
      .eq('venue_id', RIXEY)
      .ilike('subject', 'New Event:%')
      .order('timestamp', { ascending: true })
      .range(f, f + 999)
    if (error) {
      console.error('interactions fetch error:', error.message)
      break
    }
    if (!data || !data.length) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Writers (apply mode)
// ---------------------------------------------------------------------------

async function writeCalendlyQa(weddingId: string, parsed: ParsedEmail, gmailId: string | null) {
  const { data: wRow } = await sb
    .from('weddings')
    .select('calendly_qa')
    .eq('id', weddingId)
    .maybeSingle()
  const existing = (wRow?.calendly_qa as Record<string, unknown> | null) ?? {}
  const partner = partnerFieldsOf(parsed)
  const merged = {
    ...existing,
    email_parsed: {
      source_gmail_message_id: gmailId,
      invitee_name: parsed.inviteeName,
      invitee_email: parsed.inviteeEmail,
      event_type: parsed.eventType,
      event_datetime: parsed.eventDateTime,
      questions_and_answers: parsed.pairs,
      flattened: parsed.flattened,
      ...partner,
    },
  }
  const { error } = await sb.from('weddings').update({ calendly_qa: merged }).eq('id', weddingId)
  if (error) throw new Error(`calendly_qa update: ${error.message}`)
}

async function writeDiscovery(
  weddingId: string | null,
  personId: string | null,
  q: string,
  a: string,
  captureRef: string,
) {
  const { canonical, rule_matched } = mapWithRule(a)

  // Idempotency: skip if a row already exists for this capture_ref.
  const { data: existing } = await sb
    .from('discovery_sources')
    .select('id')
    .eq('venue_id', RIXEY)
    .eq('capture_source', CAPTURE_SOURCE)
    .eq('capture_ref', captureRef)
    .maybeSingle()
  if (existing) return { canonical, inserted: false }

  const { error: dsErr } = await sb.from('discovery_sources').insert({
    venue_id: RIXEY,
    wedding_id: weddingId,
    person_id: personId,
    capture_source: CAPTURE_SOURCE,
    question_text: q,
    answer_text: a,
    canonical_source: canonical,
    capture_ref: captureRef,
  })
  if (dsErr) throw new Error(`discovery_sources insert: ${dsErr.message}`)

  if (weddingId) {
    // Mirror capture.ts attribution_events shape (satisfies the
    // attribution_events_source_present CHECK via referrer_name_text).
    const discoveryAnchor = `discovery:${a}`
    const { error: attrErr } = await sb.from('attribution_events').insert({
      venue_id: RIXEY,
      wedding_id: weddingId,
      candidate_identity_id: null,
      source_platform: canonical,
      confidence: 95,
      tier: 'tier_1_full_name',
      decided_by: 'auto',
      reasoning: `Backfill from Calendly notification email. Verbatim answer: "${a.slice(0, 200)}". Mapping rule: ${rule_matched}.`,
      is_first_touch: false,
      bucket: 'attribution',
      signal_class: 'source',
      referrer_evidence_quote: `Discovery answer: "${a}"`,
      referrer_name_text: discoveryAnchor,
      referrer_relationship_text: 'discovery_source',
    })
    if (attrErr) console.warn(`  attribution_events insert failed: ${attrErr.message}`)
  }
  return { canonical, inserted: true }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function tally(items: string[]) {
  const m = new Map<string, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}

async function main() {
  console.log(`\n=== Calendly email → calendly_qa / discovery backfill ===`)
  console.log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}${LIMIT ? ` · limit ${LIMIT}` : ''}\n`)

  let rows = await fetchCalendlyEmails()
  console.log(`Fetched ${rows.length} "New Event:" interactions.`)
  if (LIMIT) rows = rows.slice(0, LIMIT)

  let parsedOk = 0
  let withWedding = 0
  let qaWritten = 0
  let discoveryFound = 0
  let discoveryWritten = 0
  let partner2Found = 0
  const discoveryAnswers: string[] = []
  const canonicalTally: string[] = []
  const sampleOut: any[] = []
  const failures: string[] = []

  for (const r of rows) {
    const parsed = parseEmail(r.full_body || '')
    if (!parsed) continue
    parsedOk++
    if (r.wedding_id) withWedding++

    const disc = discoveryAnswerOf(parsed)
    if (disc) {
      discoveryFound++
      discoveryAnswers.push(disc.a.toLowerCase().slice(0, 60))
      canonicalTally.push(mapWithRule(disc.a).canonical)
    }
    const partner = partnerFieldsOf(parsed)
    if (partner.partner2_name || partner.partner2_email) partner2Found++

    if (sampleOut.length < 6) {
      sampleOut.push({
        subject: r.subject,
        wedding_id: r.wedding_id ? r.wedding_id.slice(0, 8) : '(none)',
        invitee: parsed.inviteeName,
        partner2: partner.partner2_name,
        guests: partner.guest_count,
        date_pref: partner.date_preference,
        discovery: disc ? `${disc.a} → ${mapWithRule(disc.a).canonical}` : '(none)',
        n_pairs: parsed.pairs.length,
      })
    }

    if (APPLY) {
      try {
        if (r.wedding_id) {
          await writeCalendlyQa(r.wedding_id, parsed, r.gmail_message_id)
          qaWritten++
        }
        if (disc) {
          const ref = r.gmail_message_id || `interaction:${r.id}`
          const res = await writeDiscovery(r.wedding_id, r.person_id, disc.q, disc.a, ref)
          if (res.inserted) discoveryWritten++
        }
      } catch (e: any) {
        failures.push(`${r.id}: ${e?.message || e}`)
      }
    }
  }

  console.log(`\n--- SUMMARY ---`)
  console.log(`parsed successfully     : ${parsedOk}/${rows.length}`)
  console.log(`have wedding_id         : ${withWedding}  (${parsedOk - withWedding} orphan — calendly_qa skipped)`)
  console.log(`discovery answer found  : ${discoveryFound}`)
  console.log(`partner2 captured       : ${partner2Found}`)
  if (APPLY) {
    console.log(`calendly_qa written     : ${qaWritten}`)
    console.log(`discovery_sources new   : ${discoveryWritten}`)
    if (failures.length) {
      console.log(`\nFAILURES (${failures.length}):`)
      for (const f of failures.slice(0, 20)) console.log('  ' + f)
    }
  }

  console.log(`\n"Where did you hear" answers (top 20):`)
  for (const [a, c] of tally(discoveryAnswers).slice(0, 20)) console.log(`  ${String(c).padStart(3)}  ${a}`)
  console.log(`\nCanonical source mapping:`)
  for (const [c, n] of tally(canonicalTally)) console.log(`  ${String(n).padStart(3)}  ${c}`)

  console.log(`\nSAMPLE (first ${sampleOut.length}):`)
  for (const s of sampleOut) console.log('  ' + JSON.stringify(s))

  if (!APPLY) console.log(`\n(dry-run — re-run with --apply to write. Cascade fan-out is intentionally skipped; see file header.)`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
