/**
 * GET /api/brain-dump/entries
 *
 * Lists recent brain_dump_entries (last 30 days) for the caller's
 * venue. Used by /settings/brain-dump-log to show "what did Sage do
 * with each thing I dropped in over the last month?" alongside the
 * graduated-pattern grants list.
 *
 * Why exist: brain_dump_entries is written on every coordinator
 * submission and routed to one or more downstream tables, but the
 * /settings/brain-dump-log page only surfaced grants (the 3+
 * confirmation rule abstractions). The audit trail of individual
 * submissions had no UI counterpart — Pattern A "ship-without-
 * consumer" violation. This endpoint is the consumer side.
 *
 * T5-γ.7. Limit 50 rows ordered by created_at DESC. No pagination
 * for first cut — a 30-day window at typical volumes (5-15
 * brain-dumps/week) caps comfortably under 50.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()

  const { data, error } = await supabase
    .from('brain_dump_entries')
    .select(
      'id, raw_input, input_type, parse_status, parse_result, routed_to, clarification_question, clarification_answer, created_at, parsed_at, resolved_at, submitted_by'
    )
    .eq('venue_id', auth.venueId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort submitter-name resolution. Brain-dump entries store
  // submitted_by uuid (or null for system); resolving here keeps the
  // UI from doing a second round-trip.
  const userIds = Array.from(
    new Set(
      ((data ?? []) as Array<{ submitted_by: string | null }>)
        .map((r) => r.submitted_by)
        .filter((v): v is string => !!v)
    )
  )
  const nameById = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds)
    for (const p of (profiles ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const display = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
        || p.email
        || ''
      if (display) nameById.set(p.id, display)
    }
  }

  const entries = ((data ?? []) as Array<{
    id: string
    raw_input: string
    input_type: string
    parse_status: string
    parse_result: Record<string, unknown> | null
    routed_to: Array<{ table?: string; action?: string; field?: string }> | null
    clarification_question: string | null
    clarification_answer: string | null
    created_at: string
    parsed_at: string | null
    resolved_at: string | null
    submitted_by: string | null
  }>).map((r) => {
    // Parser may stash an `intent` on parse_result. Fall back to the
    // first routed_to.action so the UI can render something
    // meaningful even when parse_result is bare.
    const intent =
      (r.parse_result?.intent as string | undefined)
      ?? (Array.isArray(r.routed_to) && r.routed_to[0]?.action)
      ?? null
    const routedTable =
      Array.isArray(r.routed_to) && r.routed_to[0]?.table
        ? (r.routed_to[0].table as string)
        : null
    return {
      id: r.id,
      raw_input: r.raw_input,
      raw_input_excerpt: r.raw_input.slice(0, 200),
      input_type: r.input_type,
      parse_status: r.parse_status,
      intent,
      routed_table: routedTable,
      routed_to: r.routed_to ?? [],
      clarification_question: r.clarification_question,
      clarification_answer: r.clarification_answer,
      submitter_name: r.submitted_by ? nameById.get(r.submitted_by) ?? null : null,
      created_at: r.created_at,
      parsed_at: r.parsed_at,
      resolved_at: r.resolved_at,
    }
  })

  return NextResponse.json({ entries })
}
