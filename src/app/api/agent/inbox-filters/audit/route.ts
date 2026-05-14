/**
 * /api/agent/inbox-filters/audit
 *
 * For each venue_email_filters rule, count how many inbound interactions
 * the rule's pattern caught in the last 30 days, plus a few sample
 * senders + the last-match timestamp. Coordinators get answers to
 * "is this rule still pulling its weight" without leaving the settings
 * page.
 *
 * ignore rules: not auditable post-hoc. Those emails never persist (we
 * bail before the classifier writes to interactions). The endpoint
 * still returns the rule row with count=null + reason='pre_storage'.
 *
 * no_draft rules: scan interactions(direction='inbound') in last 30d
 * for matching sender, return aggregate counts and last hit.
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface FilterRow {
  id: string
  pattern_type: 'sender_exact' | 'sender_domain' | 'gmail_label'
  pattern: string
  action: 'ignore' | 'no_draft'
}

interface AuditEntry {
  filter_id: string
  pattern: string
  pattern_type: FilterRow['pattern_type']
  action: FilterRow['action']
  auditable: boolean
  unauditable_reason: string | null
  count_30d: number
  last_match_at: string | null
  sample_senders: string[]
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at === -1) return email.toLowerCase()
  return email.slice(at + 1).toLowerCase()
}

function senderMatches(filter: FilterRow, fromEmail: string): boolean {
  const pattern = filter.pattern.toLowerCase().trim()
  const from = fromEmail.toLowerCase().trim()
  if (filter.pattern_type === 'sender_exact') return from === pattern
  if (filter.pattern_type === 'sender_domain') {
    const domain = extractDomain(from)
    return domain === pattern || domain.endsWith(`.${pattern}`)
  }
  return false
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

  // Pull recent inbound interactions for the venue, plus the sender email
  // via the contacts → people join. Cap at 5000 rows — for a busy venue
  // this is the last ~30 days. If we ever spill that, we'll page or
  // push this to a materialized view.
  const { data: interactions, error: iErr } = await supabase
    .from('interactions')
    .select('id, person_id, timestamp')
    .eq('venue_id', auth.venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(5000)

  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })

  const personIds = Array.from(
    new Set(
      (interactions ?? [])
        .map((r) => (r as { person_id: string | null }).person_id)
        .filter(Boolean) as string[],
    ),
  )

  const emailByPerson = new Map<string, string>()
  if (personIds.length > 0) {
    const { data: contactRows } = await supabase
      .from('contacts')
      .select('person_id, value, people:person_id(venue_id)')
      .eq('type', 'email')
      .in('person_id', personIds)

    for (const c of contactRows ?? []) {
      const row = c as unknown as {
        person_id: string
        value: string
        people:
          | { venue_id: string | null }
          | { venue_id: string | null }[]
          | null
      }
      const person = Array.isArray(row.people) ? row.people[0] : row.people
      if (person?.venue_id !== auth.venueId) continue
      const pid = row.person_id
      const val = row.value
      if (pid && val && !emailByPerson.has(pid)) {
        emailByPerson.set(pid, val.toLowerCase())
      }
    }
  }

  const audit: AuditEntry[] = rows.map((f) => {
    if (f.action === 'ignore') {
      return {
        filter_id: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
        action: f.action,
        auditable: false,
        unauditable_reason: 'pre_storage',
        count_30d: 0,
        last_match_at: null,
        sample_senders: [],
      }
    }
    if (f.pattern_type === 'gmail_label') {
      return {
        filter_id: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
        action: f.action,
        auditable: false,
        unauditable_reason: 'label_not_stored',
        count_30d: 0,
        last_match_at: null,
        sample_senders: [],
      }
    }

    let count = 0
    let lastMatchAt: string | null = null
    const sampleSendersSet = new Set<string>()
    for (const it of interactions ?? []) {
      const row = it as { id: string; person_id: string | null; timestamp: string }
      if (!row.person_id) continue
      const email = emailByPerson.get(row.person_id)
      if (!email) continue
      if (!senderMatches(f, email)) continue
      count++
      if (!lastMatchAt || row.timestamp > lastMatchAt) lastMatchAt = row.timestamp
      if (sampleSendersSet.size < 5) sampleSendersSet.add(email)
    }

    return {
      filter_id: f.id,
      pattern: f.pattern,
      pattern_type: f.pattern_type,
      action: f.action,
      auditable: true,
      unauditable_reason: null,
      count_30d: count,
      last_match_at: lastMatchAt,
      sample_senders: Array.from(sampleSendersSet),
    }
  })

  return NextResponse.json({ audit })
}
