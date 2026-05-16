/**
 * Historical Gmail backfill — server-side background job.
 *
 * A 12-month-plus backfill of a real venue inbox is hours of work. It
 * cannot run as a browser loop: a laptop sleeping or a wifi blip kills
 * it and the cursor is lost. So the job lives in the database (state on
 * the `venues` row) and is advanced one chunk per `email_poll` cron
 * tick (every 5 minutes). The coordinator clicks "Import historical
 * email" once to enqueue it; the cron does the rest, unattended.
 *
 * Two phases the cron walks through end to end:
 *   "general" — the last 12 months of the whole inbox, one week-window
 *               at a time (Gmail after:/before: so the cursor advances).
 *   "booked"  — then every booked / completed couple, searched by their
 *               own email addresses AND their full names (Gmail phrase
 *               search reaches a Knot/WeddingWire relay inquiry whose
 *               body carries the couple's name).
 *
 * Every message routes through processIncomingEmail (parse_only). When
 * both phases finish a Backwards Tracer run is requested so each
 * couple's first-touch source is reconstructed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchNewEmails } from './gmail'
import { processIncomingEmail } from './pipeline'

const GENERAL_WEEKS = 52
const LOOKBACK_DAYS_BOOKED = 1095 // 3 years
const MAX_MSGS_PER_WEEK = 400
const MAX_MSGS_PER_COUPLE = 80
// Per cron tick. Headroom under the cron function's maxDuration.
const CHUNK_BUDGET_MS = 240_000
// A "running" row older than this is treated as a dead function and
// reclaimed by the next tick.
const STALE_RUNNING_MS = 12 * 60 * 1000

export type BackfillPhase = 'general' | 'booked'

function ymd(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function gmailQueryForCouple(
  emails: string[],
  names: Array<{ first: string | null; last: string | null }>,
): string {
  const terms: string[] = []
  for (const e of emails) terms.push(`from:${e}`, `to:${e}`)
  for (const n of names) {
    const first = (n.first ?? '').trim()
    const last = (n.last ?? '').trim()
    // A bare first name matches too much of an inbox to be useful.
    if (first.length >= 2 && last.length >= 2) terms.push(`"${first} ${last}"`)
  }
  return terms.length > 0 ? `(${terms.join(' OR ')})` : '()'
}

export interface ChunkResult {
  emailsProcessed: number
  errors: number
  nextPhase: BackfillPhase
  nextCursor: number
  done: boolean
}

/**
 * Process ONE chunk of the backfill within a time budget. Pure with
 * respect to the venue row — the caller persists nextPhase/nextCursor.
 */
export async function processBackfillChunk(
  supabase: SupabaseClient,
  venueId: string,
  phase: BackfillPhase,
  cursor: number,
): Promise<ChunkResult> {
  const startedAt = Date.now()
  let emailsProcessed = 0
  let errors = 0

  const runEmail = async (
    email: Awaited<ReturnType<typeof fetchNewEmails>>[number],
  ): Promise<void> => {
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
      console.error('[historical-backfill] processIncomingEmail error:', err)
    }
  }

  // -- PHASE 1: general 12-month inbox backfill, one week-window per cursor.
  if (phase === 'general') {
    let week = cursor
    while (week < GENERAL_WEEKS && Date.now() - startedAt < CHUNK_BUDGET_MS) {
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
          if (Date.now() - startedAt > CHUNK_BUDGET_MS) break
          await runEmail(e)
        }
      } catch (err) {
        errors++
        console.error('[historical-backfill] general week', week, 'error:', err)
      }
      week++
    }
    if (week < GENERAL_WEEKS) {
      return { emailsProcessed, errors, nextPhase: 'general', nextCursor: week, done: false }
    }
    return { emailsProcessed, errors, nextPhase: 'booked', nextCursor: 0, done: false }
  }

  // -- PHASE 2: targeted per-couple 3-year search for booked couples.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, people:people(email, first_name, last_name)')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })

  const allCouples = weddings ?? []
  let idx = cursor
  while (idx < allCouples.length && Date.now() - startedAt < CHUNK_BUDGET_MS) {
    const people = (allCouples[idx].people ?? []) as Array<{
      email: string | null; first_name: string | null; last_name: string | null
    }>
    const emails = [
      ...new Set(
        people
          .map((p) => p.email?.trim().toLowerCase())
          .filter((e): e is string => !!e && e.includes('@')),
      ),
    ]
    const query = gmailQueryForCouple(
      emails,
      people.map((p) => ({ first: p.first_name, last: p.last_name })),
    )
    if (query !== '()') {
      try {
        const found = await fetchNewEmails(venueId, MAX_MSGS_PER_COUPLE, {
          sinceDays: LOOKBACK_DAYS_BOOKED,
          extraQuery: query,
          includeAllLabels: true,
        })
        for (const e of found) {
          if (Date.now() - startedAt > CHUNK_BUDGET_MS) break
          await runEmail(e)
        }
      } catch (err) {
        errors++
        console.error('[historical-backfill] couple', allCouples[idx].id, 'error:', err)
      }
    }
    idx++
  }

  const done = idx >= allCouples.length
  return { emailsProcessed, errors, nextPhase: 'booked', nextCursor: idx, done }
}

/**
 * Cron entry. Picks one venue with a pending (or stale-running)
 * historical backfill, advances it by one chunk, persists progress.
 * One venue per tick — same posture as drainPendingTracerRun.
 */
export async function drainGmailBackfill(supabase: SupabaseClient): Promise<unknown> {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString()
  // pending venues, or running venues whose worker died (stale).
  const { data: candidates } = await supabase
    .from('venues')
    .select('id, gmail_backfill_status, gmail_backfill_phase, gmail_backfill_cursor, gmail_backfill_emails, gmail_backfill_updated_at')
    .in('gmail_backfill_status', ['pending', 'running'])
    .order('gmail_backfill_updated_at', { ascending: true })
    .limit(10)

  const venue = (candidates ?? []).find((v) => {
    if (v.gmail_backfill_status === 'pending') return true
    return (v.gmail_backfill_updated_at ?? '') < staleCutoff // reclaim dead 'running'
  })
  if (!venue) return { drained: 0 }

  // Lock it.
  await supabase
    .from('venues')
    .update({ gmail_backfill_status: 'running', gmail_backfill_updated_at: new Date().toISOString() })
    .eq('id', venue.id)

  const phase = (venue.gmail_backfill_phase as BackfillPhase) ?? 'general'
  const cursor = (venue.gmail_backfill_cursor as number) ?? 0
  const priorEmails = (venue.gmail_backfill_emails as number) ?? 0

  let result: ChunkResult
  try {
    result = await processBackfillChunk(supabase, venue.id, phase, cursor)
  } catch (err) {
    await supabase
      .from('venues')
      .update({
        gmail_backfill_status: 'error',
        gmail_backfill_updated_at: new Date().toISOString(),
      })
      .eq('id', venue.id)
    return { venueId: venue.id, error: err instanceof Error ? err.message : String(err) }
  }

  await supabase
    .from('venues')
    .update({
      gmail_backfill_status: result.done ? 'complete' : 'pending',
      gmail_backfill_phase: result.nextPhase,
      gmail_backfill_cursor: result.nextCursor,
      gmail_backfill_emails: priorEmails + result.emailsProcessed,
      gmail_backfill_updated_at: new Date().toISOString(),
    })
    .eq('id', venue.id)

  if (result.done) {
    try {
      const { requestTracerRun } = await import('@/lib/services/identity/tracer-runner')
      await requestTracerRun(supabase, venue.id)
    } catch (err) {
      console.warn('[historical-backfill] requestTracerRun failed:', err)
    }
  }

  return {
    venueId: venue.id,
    phase: result.nextPhase,
    cursor: result.nextCursor,
    emailsThisTick: result.emailsProcessed,
    totalEmails: priorEmails + result.emailsProcessed,
    done: result.done,
  }
}
