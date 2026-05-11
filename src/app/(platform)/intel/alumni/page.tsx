'use client'

/**
 * /intel/alumni — Wave 14 alumni archetype dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (aggregate ≠ disclose)
 *   - bloom-data-integrity-sweep.md (the aggregate-only contract)
 *   - bloom-may9-llm-vs-template.md (alumni archetypes are LLM-derived,
 *     not template lookups)
 *
 * Aggregate-only contract: this page NEVER names a specific couple.
 * Archetype rows show the LLM-discovered label + conversion signature +
 * voice principles + outcome summary. The "Generate / Refresh" action
 * triggers a Sonnet call that re-derives the archetypes for this venue.
 */

import { useEffect, useState, useCallback } from 'react'
import { Loader2, RefreshCw, Sparkles, Users } from 'lucide-react'

interface Archetype {
  id: string
  venueId: string
  archetypeLabel: string
  archetypeDescription: string
  bookedCoupleCount: number
  conversionSignature: {
    typical_first_touch_to_booked_days?: number | null
    typical_inquiry_channel_distribution?: Record<string, number>
    typical_decision_dynamics?: string | null
  }
  personaDistribution: Record<string, number>
  voicePrinciples: string[]
  outcomeSummary: {
    typical_booking_value_cents?: number | null
    typical_guest_count?: number | null
    repeat_referral_likelihood?: string
    notes?: string | null
  }
  refreshedAt: string
  promptVersion: string
  costCents: number
}

interface ListResponse {
  ok: boolean
  count?: number
  archetypes?: Archetype[]
  error?: string
}

interface GenerateResponse {
  ok: boolean
  bookedCoupleCount?: number
  archetypesUpserted?: number
  costCents?: number
  refusals?: Array<{ field: string; reason: string }>
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

function formatCurrency(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${Math.round(cents / 100).toLocaleString()}`
}

export default function IntelAlumniDashboard() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateMessage, setGenerateMessage] = useState<string | null>(null)

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/intel/alumni/list', { cache: 'no-store' })
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

  const onGenerate = async () => {
    setGenerating(true)
    setGenerateMessage(null)
    try {
      const res = await fetch('/api/admin/intel/alumni/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as GenerateResponse
      if (!res.ok || !body.ok) {
        setGenerateMessage(`Error: ${body.error ?? `HTTP ${res.status}`}`)
      } else {
        setGenerateMessage(
          `Generated ${body.archetypesUpserted ?? 0} archetype(s) from ` +
            `${body.bookedCoupleCount ?? 0} booked couple(s). ` +
            `Cost ~${((body.costCents ?? 0) / 100).toFixed(4)}¢.`,
        )
        await fetchList()
      }
    } catch (err) {
      setGenerateMessage(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGenerating(false)
    }
  }

  const archetypes = data?.archetypes ?? []

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-serif text-stone-900 flex items-center gap-2">
            <Users className="w-6 h-6 text-sage-500" />
            Alumni archetypes
          </h1>
          <p className="text-sm text-stone-500 mt-1">
            Your venue&apos;s typical booked-couple profiles, discovered from
            past bookings. Aggregate-only — no individual couples are named.
          </p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          className="inline-flex items-center gap-2 rounded-md bg-sage-500 text-white px-3 py-1.5 text-sm hover:bg-sage-600 disabled:opacity-50"
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          {archetypes.length === 0 ? 'Generate archetypes' : 'Refresh archetypes'}
        </button>
      </div>

      {generateMessage && (
        <div className="text-sm text-stone-700 mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
          {generateMessage}
        </div>
      )}

      {loading && (
        <div className="text-sm text-stone-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading archetypes…
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-600 mb-4">Error loading: {error}</div>
      )}

      {!loading && data && archetypes.length === 0 && (
        <div className="text-sm text-stone-500 italic mt-8 rounded-md border border-dashed border-stone-300 p-6 text-center">
          No archetypes generated yet. Click &ldquo;Generate archetypes&rdquo; to
          run the Sonnet pass over your booked couples. Cost target ~$0.10-$0.20
          per venue.
        </div>
      )}

      {!loading && data && archetypes.length > 0 && (
        <div className="space-y-4">
          {archetypes.map((a) => (
            <article
              key={a.id}
              className="rounded-lg border border-stone-200 bg-white p-5"
            >
              <header className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-serif text-stone-900">
                    {a.archetypeLabel}
                  </h2>
                  <p className="text-sm text-stone-600 mt-1">
                    {a.archetypeDescription}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-serif text-sage-700">
                    {a.bookedCoupleCount}
                  </div>
                  <div className="text-xs text-stone-500">booked couples</div>
                  <RefreshLabel iso={a.refreshedAt} />
                </div>
              </header>

              <div className="grid grid-cols-2 gap-6 mt-5">
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
                    Conversion signature
                  </h3>
                  <dl className="text-sm">
                    <div className="flex justify-between py-1">
                      <dt className="text-stone-500">Typical days to book</dt>
                      <dd className="text-stone-900">
                        {a.conversionSignature.typical_first_touch_to_booked_days ??
                          '—'}
                      </dd>
                    </div>
                    <div className="flex justify-between py-1">
                      <dt className="text-stone-500">Decision dynamics</dt>
                      <dd className="text-stone-900 text-right max-w-[60%]">
                        {a.conversionSignature.typical_decision_dynamics ?? '—'}
                      </dd>
                    </div>
                    <div className="flex justify-between py-1 items-start">
                      <dt className="text-stone-500">Channel mix</dt>
                      <dd className="text-stone-900 text-right max-w-[60%]">
                        {Object.entries(
                          a.conversionSignature.typical_inquiry_channel_distribution ??
                            {},
                        )
                          .map(([k, v]) => `${k} (${v})`)
                          .join(', ') || '—'}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
                    Outcome summary
                  </h3>
                  <dl className="text-sm">
                    <div className="flex justify-between py-1">
                      <dt className="text-stone-500">Typical booking value</dt>
                      <dd className="text-stone-900">
                        {formatCurrency(a.outcomeSummary.typical_booking_value_cents)}
                      </dd>
                    </div>
                    <div className="flex justify-between py-1">
                      <dt className="text-stone-500">Typical guest count</dt>
                      <dd className="text-stone-900">
                        {a.outcomeSummary.typical_guest_count ?? '—'}
                      </dd>
                    </div>
                    <div className="flex justify-between py-1">
                      <dt className="text-stone-500">Repeat referral likelihood</dt>
                      <dd className="text-stone-900">
                        {a.outcomeSummary.repeat_referral_likelihood ?? 'unknown'}
                      </dd>
                    </div>
                    {a.outcomeSummary.notes && (
                      <div className="flex justify-between py-1 items-start">
                        <dt className="text-stone-500">Notes</dt>
                        <dd className="text-stone-900 text-right max-w-[60%] italic">
                          {a.outcomeSummary.notes}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              </div>

              {a.voicePrinciples.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
                    Voice principles for fresh leads matching this archetype
                  </h3>
                  <ul className="text-sm text-stone-800 space-y-1">
                    {a.voicePrinciples.map((p, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="text-sage-500">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {Object.keys(a.personaDistribution).length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
                    Persona distribution (Wave-5A labels in this cohort)
                  </h3>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {Object.entries(a.personaDistribution).map(([label, count]) => (
                      <span
                        key={label}
                        className="rounded-full bg-stone-100 text-stone-700 px-2 py-0.5"
                      >
                        {label} ({count})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function RefreshLabel({ iso }: { iso: string }) {
  return (
    <div className="text-[10px] text-stone-400 mt-1">
      refreshed {relativeTime(iso)}
    </div>
  )
}
