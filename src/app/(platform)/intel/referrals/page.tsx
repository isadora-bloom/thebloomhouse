'use client'

/**
 * /intel/referrals — Wave 14 referral attribution dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; referrer mentions are a forensic linkage to past couples)
 *   - bloom-wave4-identity-reconstruction.md (sibling-extractor pattern)
 *   - bloom-phase-b-decisions.md (attribution_events audit row)
 *
 * Sections:
 *   - Resolved referrer → couple links (referrer_wedding_id NOT NULL)
 *   - Ambiguous / unresolved (operator review queue with the LLM
 *     evidence quote + suggested candidates from the API)
 *
 * Per the spec: "Do NOT auto-execute referral linkage on low-confidence
 * matches — defer to operator review." This UI is the operator queue.
 */

import { useEffect, useState, useCallback } from 'react'
import { ArrowUpRight, Loader2, RefreshCw, Share2 } from 'lucide-react'

interface ReferralRow {
  id: string
  venue_id: string
  wedding_id: string
  referrer_wedding_id: string | null
  referrer_name_text: string | null
  referrer_relationship_text: string | null
  referrer_evidence_quote: string | null
  referrer_confidence_0_100: number | null
  referral_resolved_at: string | null
  confidence: number
  tier: string
  decided_by: string
  reasoning: string | null
  decided_at: string
  reverted_at: string | null
}

interface ListResponse {
  ok: boolean
  count?: number
  matched_count?: number
  ambiguous_count?: number
  rows?: ReferralRow[]
  error?: string
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export default function IntelReferralsDashboard() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/intel/referrals/list?limit=500', {
        cache: 'no-store',
      })
      const body = (await res.json()) as ListResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        setData(null)
        return
      }
      setData(body)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [fetchList])

  const onRefresh = async () => {
    setRefreshing(true)
    await fetchList()
    setRefreshing(false)
  }

  const matched = (data?.rows ?? []).filter((r) => r.referrer_wedding_id !== null)
  const ambiguous = (data?.rows ?? []).filter((r) => r.referrer_wedding_id === null)

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-serif text-stone-900 flex items-center gap-2">
            <Share2 className="w-6 h-6 text-sage-500" />
            Referral attribution
          </h1>
          <p className="text-sm text-stone-500 mt-1">
            Word-of-mouth referrer mentions extracted from couple bodies. Resolved
            links credit past couples; ambiguous entries wait for operator review.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-3 py-1.5 text-sm hover:bg-stone-50"
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Refresh
        </button>
      </div>

      {loading && (
        <div className="text-sm text-stone-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading referrals…
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-600 mb-4">Error loading: {error}</div>
      )}

      {!loading && data && (
        <>
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="rounded-lg border border-stone-200 p-4 bg-white">
              <div className="text-xs text-stone-500">Total referrals</div>
              <div className="text-2xl font-serif text-stone-900">{data.count ?? 0}</div>
            </div>
            <div className="rounded-lg border border-stone-200 p-4 bg-white">
              <div className="text-xs text-stone-500">Resolved → past couple</div>
              <div className="text-2xl font-serif text-emerald-700">
                {data.matched_count ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-stone-200 p-4 bg-white">
              <div className="text-xs text-stone-500">Awaiting review</div>
              <div className="text-2xl font-serif text-amber-700">
                {data.ambiguous_count ?? 0}
              </div>
            </div>
          </div>

          <section className="mb-10">
            <h2 className="text-lg font-serif text-stone-900 mb-3">
              Resolved referrer links
            </h2>
            {matched.length === 0 ? (
              <div className="text-sm text-stone-500 italic">
                No resolved referrer linkages yet. As couples mention past
                couples by name, links appear here.
              </div>
            ) : (
              <ul className="space-y-3">
                {matched.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium text-stone-900">
                          <span className="text-emerald-700">
                            {r.referrer_name_text}
                          </span>{' '}
                          referred{' '}
                          <a
                            href={`/agent/inbox?wedding=${r.wedding_id}`}
                            className="underline decoration-stone-300 hover:decoration-stone-500"
                          >
                            this couple <ArrowUpRight className="inline w-3 h-3" />
                          </a>
                        </div>
                        <div className="text-xs text-stone-500 mt-1">
                          Relationship: {r.referrer_relationship_text ?? 'unknown'} ·
                          LLM confidence {r.referrer_confidence_0_100 ?? '–'}% ·
                          decided {relativeTime(r.decided_at)}
                        </div>
                        {r.referrer_evidence_quote && (
                          <blockquote className="mt-2 text-sm text-stone-700 italic border-l-2 border-emerald-300 pl-3">
                            “{r.referrer_evidence_quote}”
                          </blockquote>
                        )}
                      </div>
                      <a
                        href={`/agent/inbox?wedding=${r.referrer_wedding_id}`}
                        className="text-xs text-sage-700 underline whitespace-nowrap"
                      >
                        view referrer
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-lg font-serif text-stone-900 mb-3">
              Awaiting operator review
            </h2>
            {ambiguous.length === 0 ? (
              <div className="text-sm text-stone-500 italic">
                No ambiguous referrals waiting. Multi-candidate matches and
                un-recognised names land here for human resolution.
              </div>
            ) : (
              <ul className="space-y-3">
                {ambiguous.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-amber-200 bg-amber-50/40 p-4"
                  >
                    <div className="text-sm font-medium text-stone-900">
                      Mention of{' '}
                      <span className="text-amber-700">
                        {r.referrer_name_text}
                      </span>{' '}
                      in{' '}
                      <a
                        href={`/agent/inbox?wedding=${r.wedding_id}`}
                        className="underline decoration-stone-300 hover:decoration-stone-500"
                      >
                        this couple <ArrowUpRight className="inline w-3 h-3" />
                      </a>
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      Relationship: {r.referrer_relationship_text ?? 'unknown'} ·
                      LLM confidence {r.referrer_confidence_0_100 ?? '–'}% ·
                      {r.reasoning ? ` reason: ${r.reasoning}` : ''} ·
                      {' '}
                      {relativeTime(r.decided_at)}
                    </div>
                    {r.referrer_evidence_quote && (
                      <blockquote className="mt-2 text-sm text-stone-700 italic border-l-2 border-amber-300 pl-3">
                        “{r.referrer_evidence_quote}”
                      </blockquote>
                    )}
                    <div className="mt-2 text-xs text-stone-500">
                      Operator action: search for the named referrer in your
                      booked-couple list and link manually (UI pending). Until
                      then, the name is recorded — future correlation will pick
                      it up automatically.
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
