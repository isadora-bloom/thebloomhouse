/**
 * /api/agent/inbox-filters/audit
 *
 * For each venue_email_filters rule, count how many emails the rule
 * caught in the last 30 days, plus a few sample senders + the last-
 * match timestamp.
 *
 * Data source: venue_email_filter_matches (migration 339). The pipeline
 * writes one row per filter decision, so ignore + no_draft + gmail_label
 * rules are all real numbers from here, not derived guesses. The log
 * holds 90 days of decisions; the audit endpoint windows to 30.
 *
 * No fallback to the legacy interaction-scan path: if a venue is on a
 * pre-339 codepath, the row simply shows count_30d=0 and the operator
 * sees that the rule has not fired (which is the honest signal).
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface AuditEntry {
  filter_id: string
  pattern: string
  pattern_type: 'sender_exact' | 'sender_domain' | 'gmail_label'
  action: 'ignore' | 'no_draft'
  auditable: boolean
  unauditable_reason: string | null
  count_30d: number
  last_match_at: string | null
  sample_senders: string[]
}

interface FilterRow {
  id: string
  pattern_type: 'sender_exact' | 'sender_domain' | 'gmail_label'
  pattern: string
  action: 'ignore' | 'no_draft'
}

interface MatchRow {
  filter_id: string
  from_email: string
  matched_at: string
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()

  const { data: filters, error: fErr } = await supabase
    .from('venue_email_filters')
    .select('id, pattern_type, pattern, action')
    .eq('venue_id', auth.venueId)

  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
  const rows: FilterRow[] = (filters ?? []) as FilterRow[]

  if (rows.length === 0) {
    return NextResponse.json({ audit: [] })
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // One scan, then group in-memory. Capped at 10k decisions per 30-day
  // window — a busy venue with a chatty ignore rule could exceed; if so
  // we'll switch to per-rule queries.
  const { data: matchRows, error: mErr } = await supabase
    .from('venue_email_filter_matches')
    .select('filter_id, from_email, matched_at')
    .eq('venue_id', auth.venueId)
    .gte('matched_at', since)
    .order('matched_at', { ascending: false })
    .limit(10000)

  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 })

  const byFilter = new Map<string, { count: number; last: string | null; senders: Set<string> }>()
  for (const m of (matchRows ?? []) as MatchRow[]) {
    const existing = byFilter.get(m.filter_id) ?? {
      count: 0,
      last: null as string | null,
      senders: new Set<string>(),
    }
    existing.count++
    if (!existing.last || m.matched_at > existing.last) existing.last = m.matched_at
    if (existing.senders.size < 5) existing.senders.add(m.from_email)
    byFilter.set(m.filter_id, existing)
  }

  const audit: AuditEntry[] = rows.map((f) => {
    const agg = byFilter.get(f.id)
    return {
      filter_id: f.id,
      pattern: f.pattern,
      pattern_type: f.pattern_type,
      action: f.action,
      auditable: true,
      unauditable_reason: null,
      count_30d: agg?.count ?? 0,
      last_match_at: agg?.last ?? null,
      sample_senders: agg ? Array.from(agg.senders) : [],
    }
  })

  return NextResponse.json({ audit })
}
