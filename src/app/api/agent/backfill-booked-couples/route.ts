import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchNewEmails } from '@/lib/services/email/gmail'
import { processIncomingEmail } from '@/lib/services/email/pipeline'

// Gmail fetch x classifier per email — give it the full Vercel budget.
export const maxDuration = 300

// ---------------------------------------------------------------------------
// POST /api/agent/backfill-booked-couples?phase=general|booked&cursor=N
//
// Combined historical Gmail backfill, run in two phases the UI loops
// through end-to-end:
//
//   PHASE "general" — pull the last 12 months of the whole inbox, one
//   week-window at a time (Gmail `after:/before:` search). Walking a
//   fixed window per cursor makes the loop actually progress, unlike a
//   bare `newer_than:365d` which returns the same first page every call.
//
//   PHASE "booked" — then, for every booked / completed couple, run a
//   Gmail search scoped to that couple's own email addresses across the
//   last 3 years. A couple often first inquired long before they booked;
//   their original inquiry (which proves where they came from) sits
//   outside the 12-month window. This phase reaches it.
//
// Every message routes through the shared pipeline (parse_only — no
// drafts, these are historical). When both phases finish it requests a
// Backwards Tracer run so each couple's first-touch source is
// reconstructed from the imported history.
//
// Chunked: each call does as much as fits a soft time budget, then
// returns { done, nextPhase, nextCursor } for the UI to loop.
// ---------------------------------------------------------------------------

const GENERAL_WEEKS = 52          // 12 months, walked one week at a time
const COUPLES_PER_UNIT = 4        // booked couples processed per loop unit
const LOOKBACK_DAYS_BOOKED = 1095 // 3 years for the targeted couple search
const MAX_MSGS_PER_WEEK = 400
const MAX_MSGS_PER_COUPLE = 80
const BUDGET_MS = 255_000         // 4.25 min, headroom under maxDuration

function ymd(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * Build the Gmail search for one couple. Matches on BOTH the couple's
 * own email addresses AND their full names as quoted phrases.
 *
 * Why names matter: a booked couple's FIRST inquiry — the email that
 * proves where they came from — very often did not arrive from their
 * own address. The Knot / WeddingWire relay an inquiry from a
 * marketplace address (member@theknot.com etc.) with the couple's real
 * name and details in the BODY. A from:/to: search alone never finds
 * it. Gmail's quoted-phrase search covers the subject and body, so
 * `"Caitlin McCarrington"` reaches the relay email.
 */
function gmailQueryForCouple(
  emails: string[],
  names: Array<{ first: string | null; last: string | null }>,
): string {
  const terms: string[] = []
  for (const e of emails) {
    terms.push(`from:${e}`, `to:${e}`)
  }
  for (const n of names) {
    const first = (n.first ?? '').trim()
    const last = (n.last ?? '').trim()
    // Require first AND last — a bare first name ("Sarah") matches far
    // too much of an inbox to be a useful body-search term.
    if (first.length >= 2 && last.length >= 2) {
      terms.push(`"${first} ${last}"`)
    }
  }
  return `(${terms.join(' OR ')})`
}

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const url = new URL(req.url)
  const phase = url.searchParams.get('phase') === 'booked' ? 'booked' : 'general'
  const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0)

  const supabase = createServiceClient()
  const startedAt = Date.now()

  let emailsProcessed = 0
  let unitsProcessed = 0
  let errors = 0

  const runEmail = async (email: Awaited<ReturnType<typeof fetchNewEmails>>[number]) => {
    try {
      await processIncomingEmail(
        venueId,
        {
          messageId: email.messageId,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          subject: email.subject,
          body: email.body,
          date: email.date,
          labels: email.labels,
          connectionId: email.connectionId,
          headers: email.headers,
        },
        { skipDraft: true },
      )
      emailsProcessed++
    } catch (err) {
      errors++
      console.error('[backfill-booked-couples] processIncomingEmail error:', err)
    }
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — general 12-month inbox backfill, one week-window per cursor.
  // -------------------------------------------------------------------------
  if (phase === 'general') {
    let week = cursor
    while (week < GENERAL_WEEKS && Date.now() - startedAt < BUDGET_MS) {
      const before = new Date()
      before.setDate(before.getDate() - week * 7)
      const after = new Date()
      after.setDate(after.getDate() - (week + 1) * 7)
      try {
        const found = await fetchNewEmails(venueId, MAX_MSGS_PER_WEEK, {
          extraQuery: `after:${ymd(after)} before:${ymd(before)}`,
          includeAllLabels: true,
        })
        for (const e of found) {
          if (Date.now() - startedAt > BUDGET_MS) break
          await runEmail(e)
        }
      } catch (err) {
        errors++
        console.error('[backfill-booked-couples] general week', week, 'error:', err)
      }
      week++
      unitsProcessed++
    }
    if (week < GENERAL_WEEKS) {
      return NextResponse.json({
        ok: true, done: false, phase: 'general',
        nextPhase: 'general', nextCursor: week,
        weeksDone: week, weeksTotal: GENERAL_WEEKS,
        emailsProcessed, errors,
      })
    }
    // General phase complete — hand off to the booked phase.
    return NextResponse.json({
      ok: true, done: false, phase: 'general',
      nextPhase: 'booked', nextCursor: 0,
      weeksDone: GENERAL_WEEKS, weeksTotal: GENERAL_WEEKS,
      emailsProcessed, errors,
    })
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — targeted per-couple 3-year search for booked couples.
  // -------------------------------------------------------------------------
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id, people:people(email, first_name, last_name)')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
  if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 })

  const allCouples = weddings ?? []
  let idx = cursor
  let couplesSkippedNoEmail = 0

  while (idx < allCouples.length && Date.now() - startedAt < BUDGET_MS) {
    const w = allCouples[idx]
    const people = (w.people ?? []) as Array<{
      email: string | null; first_name: string | null; last_name: string | null
    }>
    const emails = [
      ...new Set(
        people
          .map((p) => p.email?.trim().toLowerCase())
          .filter((e): e is string => !!e && e.includes('@')),
      ),
    ]
    const names = people.map((p) => ({ first: p.first_name, last: p.last_name }))
    const query = gmailQueryForCouple(emails, names)
    // A couple with neither an email nor a full name is unsearchable.
    if (query === '()') {
      couplesSkippedNoEmail++
    } else {
      try {
        const found = await fetchNewEmails(venueId, MAX_MSGS_PER_COUPLE, {
          sinceDays: LOOKBACK_DAYS_BOOKED,
          extraQuery: query,
          includeAllLabels: true,
        })
        for (const e of found) {
          if (Date.now() - startedAt > BUDGET_MS) break
          await runEmail(e)
        }
      } catch (err) {
        errors++
        console.error('[backfill-booked-couples] couple', w.id, 'error:', err)
      }
    }
    idx++
    unitsProcessed++
    // Soft-stop on a unit boundary so the cursor is always couple-aligned.
    if (unitsProcessed >= COUPLES_PER_UNIT && Date.now() - startedAt > BUDGET_MS / 2) break
  }

  const done = idx >= allCouples.length
  if (done) {
    try {
      const { requestTracerRun } = await import('@/lib/services/identity/tracer-runner')
      await requestTracerRun(supabase, venueId)
    } catch (err) {
      console.warn('[backfill-booked-couples] requestTracerRun failed:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    done,
    phase: 'booked',
    nextPhase: done ? null : 'booked',
    nextCursor: done ? null : idx,
    couplesDone: idx,
    couplesTotal: allCouples.length,
    couplesSkippedNoEmail,
    emailsProcessed,
    errors,
  })
}
