'use client'

/**
 * Phase E review queue tab — extracted verbatim from the legacy
 * /intel/identity-review page so the new Identity Report tab can sit
 * alongside it. The queue behaviour is unchanged from the pre-T8.2
 * implementation; it lists open candidate_matches and lets the
 * operator confirm / reject / defer each one.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + §5.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import {
  AlertCircle,
  Check,
  HelpCircle,
  X,
  ArrowRight,
  ChevronDown,
  Sparkles,
} from 'lucide-react'

interface CandidateRow {
  id: string
  venue_id: string
  primary_record_id: string
  primary_record_type: string
  secondary_record_id: string
  secondary_record_type: string
  confidence_tier: 'high' | 'medium' | 'low' | string
  matcher_reason: string | null
  created_at: string
  resolution: string | null
}

interface CoupleSnippet {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  partner_contact_name: string | null
  wedding_date: string | null
  lifecycle_state: string | null
}

interface RecordSnippet {
  id: string
  kind: 'couple' | 'fragment' | 'touchpoint'
  label: string
  detail: string
  href?: string
}

const TIERS: Array<'all' | 'high' | 'medium' | 'low'> = ['all', 'high', 'medium', 'low']

function tierClass(tier: string): string {
  if (tier === 'high')
    return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (tier === 'medium') return 'bg-amber-100 text-amber-800 border-amber-200'
  if (tier === 'low') return 'bg-stone-100 text-stone-700 border-stone-200'
  return 'bg-stone-100 text-stone-700 border-stone-200'
}

export default function ReviewQueueTab() {
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [snippets, setSnippets] = useState<Map<string, RecordSnippet>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tier, setTier] = useState<'all' | 'high' | 'medium' | 'low'>('medium')
  const [working, setWorking] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Record<string, string>>({})

  const loadRows = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('candidate_matches')
      .select(
        'id, venue_id, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type, confidence_tier, matcher_reason, created_at, resolution',
      )
      .eq('venue_id', venueId)
      .is('resolution', null)
      .order('created_at', { ascending: false })
      .limit(200)
    if (err) {
      setError(err.message)
      setRows([])
      setLoading(false)
      return
    }
    const candidates = (data ?? []) as CandidateRow[]
    setRows(candidates)

    const coupleIds = new Set<string>()
    const fragmentIds = new Set<string>()
    const touchpointIds = new Set<string>()
    for (const c of candidates) {
      const tuples: Array<[string, string]> = [
        [c.primary_record_id, c.primary_record_type],
        [c.secondary_record_id, c.secondary_record_type],
      ]
      for (const [id, kind] of tuples) {
        if (kind === 'couple') coupleIds.add(id)
        else if (kind === 'fragment') fragmentIds.add(id)
        else if (kind === 'touchpoint') touchpointIds.add(id)
      }
    }

    const [couples, fragments, touchpoints] = await Promise.all([
      coupleIds.size > 0
        ? supabase
            .from('couples')
            .select(
              'id, primary_contact_name, primary_contact_email, partner_contact_name, wedding_date, lifecycle_state',
            )
            .in('id', Array.from(coupleIds))
        : Promise.resolve({ data: [] }),
      fragmentIds.size > 0
        ? supabase
            .from('fragments')
            .select('id, channel, identity_hint, raw_payload, occurred_at')
            .in('id', Array.from(fragmentIds))
        : Promise.resolve({ data: [] }),
      touchpointIds.size > 0
        ? supabase
            .from('touchpoints')
            .select('id, channel, action_type, raw_payload, occurred_at')
            .in('id', Array.from(touchpointIds))
        : Promise.resolve({ data: [] }),
    ])

    const map = new Map<string, RecordSnippet>()
    for (const row of (couples.data ?? []) as CoupleSnippet[]) {
      const name =
        row.primary_contact_name ?? row.primary_contact_email ?? '(unnamed)'
      const partner = row.partner_contact_name ? ` & ${row.partner_contact_name}` : ''
      map.set(row.id, {
        id: row.id,
        kind: 'couple',
        label: `${name}${partner}`,
        detail: [row.primary_contact_email, row.wedding_date, row.lifecycle_state]
          .filter(Boolean)
          .join(' · '),
        href: `/intel/couples/${row.id}`,
      })
    }
    for (const row of (fragments.data ?? []) as Array<{
      id: string
      channel: string
      identity_hint: string | null
      raw_payload: Record<string, unknown> | null
      occurred_at: string
    }>) {
      map.set(row.id, {
        id: row.id,
        kind: 'fragment',
        label: `${row.channel} fragment: ${row.identity_hint ?? '(no hint)'}`,
        detail: new Date(row.occurred_at).toLocaleString(),
      })
    }
    for (const row of (touchpoints.data ?? []) as Array<{
      id: string
      channel: string
      action_type: string
      raw_payload: Record<string, unknown> | null
      occurred_at: string
    }>) {
      const subject = (row.raw_payload as Record<string, unknown> | null)?.subject as string | undefined
      map.set(row.id, {
        id: row.id,
        kind: 'touchpoint',
        label: `${row.channel} ${row.action_type.replace(/_/g, ' ')}`,
        detail:
          (subject ? `"${subject}" · ` : '') + new Date(row.occurred_at).toLocaleString(),
      })
    }
    setSnippets(map)
    setLoading(false)
  }, [venueId, supabase])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const filtered = useMemo(
    () => (tier === 'all' ? rows : rows.filter((r) => r.confidence_tier === tier)),
    [rows, tier],
  )

  const counts = useMemo(() => {
    const acc = { all: rows.length, high: 0, medium: 0, low: 0 }
    for (const r of rows) {
      if (r.confidence_tier === 'high') acc.high += 1
      else if (r.confidence_tier === 'medium') acc.medium += 1
      else if (r.confidence_tier === 'low') acc.low += 1
    }
    return acc
  }, [rows])

  const resolve = async (matchId: string, action: 'confirm' | 'reject' | 'defer') => {
    setWorking(matchId)
    setFeedback((f) => ({ ...f, [matchId]: '' }))
    try {
      const res = await fetch('/api/admin/identity/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, action }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        resolution?: string
        cascaded?: { touchpoints_reparented: number; fragments_promoted: number }
        error?: string
      }
      if (!res.ok || !data.ok) {
        setFeedback((f) => ({ ...f, [matchId]: data.error ?? 'failed' }))
      } else {
        const c = data.cascaded
        const cascade = c
          ? ` · tp re-parented ${c.touchpoints_reparented}, fragment promoted ${c.fragments_promoted}`
          : ''
        setFeedback((f) => ({
          ...f,
          [matchId]: `${data.resolution}${cascade}`,
        }))
        setRows((rs) => rs.filter((r) => r.id !== matchId))
      }
    } catch (err) {
      setFeedback((f) => ({
        ...f,
        [matchId]: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setWorking(null)
    }
  }

  return (
    <div>
      <div className="mb-4">
        <p className="max-w-2xl text-sm text-stone-600">
          The matcher and LLM judge proposed these couplings. High tier
          auto-promoted; medium and low are here for your call. Confirming
          collapses fragments / orphan touchpoints into the matched couple
          and writes an audit row. Rejecting flips status without
          re-parenting.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TIERS.map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={`rounded-full border px-3 py-1 text-xs ${
              tier === t
                ? 'border-stone-900 bg-stone-900 text-white'
                : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
            }`}
          >
            {t === 'all' ? 'All' : t}{' '}
            <span className={tier === t ? 'opacity-70' : 'text-stone-400'}>
              {counts[t]}
            </span>
          </button>
        ))}
        <span className="ml-2 text-xs text-stone-500">
          {filtered.length} shown
        </span>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertCircle className="mt-0.5 h-4 w-4" /> {error}
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          Loading...
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          Nothing waiting. The matcher will route new uncertain cases here as
          they arrive.
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((r) => {
          const a = snippets.get(r.primary_record_id)
          const b = snippets.get(r.secondary_record_id)
          const note = feedback[r.id]
          const busy = working === r.id
          return (
            <div
              key={r.id}
              className="overflow-hidden rounded-lg border border-stone-200 bg-white"
            >
              <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50 px-4 py-2 text-xs">
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${tierClass(
                    r.confidence_tier,
                  )}`}
                >
                  <HelpCircle className="h-3 w-3" /> {r.confidence_tier}
                </span>
                <span className="text-stone-500">
                  proposed {new Date(r.created_at).toLocaleString()}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[1fr_auto_1fr]">
                <RecordCard side="Primary" record={a} type={r.primary_record_type} id={r.primary_record_id} />
                <div className="hidden self-center text-stone-300 md:block">
                  <ArrowRight className="h-5 w-5" />
                </div>
                <RecordCard side="Candidate" record={b} type={r.secondary_record_type} id={r.secondary_record_id} />
              </div>
              {r.matcher_reason && (
                <div className="border-t border-stone-100 bg-stone-50/60 px-4 py-2 text-xs text-stone-600">
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3 text-violet-500" />{' '}
                    {r.matcher_reason}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-stone-100 px-4 py-2">
                <div className="text-xs text-stone-500">
                  {note && <span className="text-stone-700">{note}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => resolve(r.id, 'reject')}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    <X className="h-3 w-3" /> Reject
                  </button>
                  <button
                    onClick={() => resolve(r.id, 'defer')}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                  >
                    <ChevronDown className="h-3 w-3" /> Not sure
                  </button>
                  <button
                    onClick={() => resolve(r.id, 'confirm')}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" /> Confirm
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RecordCard({
  side,
  record,
  type,
  id,
}: {
  side: string
  record: RecordSnippet | undefined
  type: string
  id: string
}) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
        {side} <span className="text-stone-400">({type})</span>
      </div>
      {record ? (
        <>
          {record.href ? (
            <a
              href={record.href}
              className="text-sm font-medium text-stone-900 underline-offset-2 hover:underline"
            >
              {record.label}
            </a>
          ) : (
            <div className="text-sm font-medium text-stone-900">{record.label}</div>
          )}
          {record.detail && (
            <div className="mt-0.5 text-xs text-stone-500">{record.detail}</div>
          )}
        </>
      ) : (
        <div className="text-sm text-stone-400">id: {id.slice(0, 8)}...</div>
      )}
    </div>
  )
}
