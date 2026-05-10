'use client'

/**
 * Wave 7B — channel-role audit page (admin viewer).
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Read-only coordinator surface that surfaces the role-summary aggregate
 * for the current venue. The headline reveal: "X% of theknot.com leads
 * are validation, not acquisition." Per-channel role split + classifier
 * coverage stats + manual reclassify trigger.
 *
 * Wave 7D will replace this with a richer discovery dashboard. This is
 * the minimal "the data is real, here's the split" view.
 */

import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, ArrowRight, Compass, RefreshCw } from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface PerChannelRoleCounts {
  channel: string
  total: number
  acquisition: number
  validation: number
  conversion: number
  mixed: number
  unknown: number
  acquisition_share_0_1: number | null
  validation_share_0_1: number | null
}

interface RoleSummary {
  ok: boolean
  venueId: string
  totalEvents: number
  byRole: Record<string, number>
  byChannel: PerChannelRoleCounts[]
  unclassifiedCount: number
  latestClassifiedAt: string | null
  error?: string
}

function pct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—'
  return `${Math.round(x * 100)}%`
}

export default function AttributionRolesPage() {
  const venueId = useVenueId()
  const [summary, setSummary] = useState<RoleSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalClassified = useMemo(() => {
    if (!summary) return 0
    return summary.totalEvents - (summary.unclassifiedCount ?? 0)
  }, [summary])

  const knotChannel = useMemo(() => {
    if (!summary) return null
    return summary.byChannel.find((c) => c.channel === 'the_knot' || c.channel === 'theknot')
  }, [summary])

  async function load() {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/attribution/role-summary?venueId=${venueId}`)
      const json = (await res.json()) as RoleSummary
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      setSummary(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function reclassify(force: boolean) {
    if (!venueId) return
    setReclassifying(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/attribution/reclassify-roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'sync', limit: 50, force, venueId }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReclassifying(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId])

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif text-stone-900 mb-2">Channel-Role Audit</h1>
          <p className="text-stone-600 max-w-3xl">
            Forensic re-attribution. Each touchpoint classified as{' '}
            <span className="font-semibold text-emerald-700">acquisition</span> (sourced the
            couple), <span className="font-semibold text-amber-700">validation</span> (couple
            discovered venue elsewhere; used this channel as intake), or{' '}
            <span className="font-semibold text-sky-700">conversion</span> (closing-step event).
            The headline question: of your &ldquo;Knot leads&rdquo;, how many were actually
            sourced by Knot?
          </p>
        </div>
        <button
          onClick={() => reclassify(false)}
          disabled={reclassifying || !venueId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${reclassifying ? 'animate-spin' : ''}`} />
          {reclassifying ? 'Classifying…' : 'Reclassify (50)'}
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-red-900">Error</div>
            <div className="text-sm text-red-800">{error}</div>
          </div>
        </div>
      )}

      {loading && !summary && (
        <div className="text-stone-500">Loading role summary…</div>
      )}

      {summary && (
        <>
          {/* The headline: validation share for Knot. */}
          {knotChannel && (
            <div className="mb-6 p-6 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2 text-amber-900">
                <Compass className="w-5 h-5" />
                <span className="font-serif text-lg">The Knot reveal</span>
              </div>
              <div className="text-3xl font-serif text-stone-900 mb-1">
                {pct(knotChannel.validation_share_0_1)} of{' '}
                <span className="font-mono text-2xl">the_knot</span> attributions are{' '}
                <span className="text-amber-700 font-semibold">validation</span>, not
                acquisition.
              </div>
              <div className="text-sm text-stone-700">
                {knotChannel.validation} of {knotChannel.acquisition + knotChannel.validation}{' '}
                Knot touchpoints (excluding conversions and unclassified) were classified as
                couples who discovered the venue elsewhere and used Knot as the intake form.
                Spend strategy: every dollar redirected from Knot acquisition to the channel
                that actually sourced these couples ought to outperform.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <RoleCard label="Total events" value={summary.totalEvents} tone="neutral" />
            <RoleCard
              label="Classified"
              value={totalClassified}
              hint={`${pct(summary.totalEvents > 0 ? totalClassified / summary.totalEvents : null)} coverage`}
              tone="neutral"
            />
            <RoleCard
              label="Acquisition"
              value={summary.byRole.acquisition ?? 0}
              tone="emerald"
            />
            <RoleCard
              label="Validation"
              value={summary.byRole.validation ?? 0}
              tone="amber"
            />
            <RoleCard
              label="Conversion"
              value={summary.byRole.conversion ?? 0}
              tone="sky"
            />
            <RoleCard label="Unknown" value={summary.byRole.unknown ?? 0} tone="stone" />
          </div>

          {/* Per-channel breakdown */}
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-stone-200 bg-stone-50">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-stone-600" />
                <span className="font-medium text-stone-900">Per-channel role split</span>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-stone-600">
                <tr>
                  <th className="px-4 py-2 text-left">Channel</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right text-emerald-700">Acquisition</th>
                  <th className="px-4 py-2 text-right text-amber-700">Validation</th>
                  <th className="px-4 py-2 text-right text-sky-700">Conversion</th>
                  <th className="px-4 py-2 text-right">Mixed</th>
                  <th className="px-4 py-2 text-right">Unclassified</th>
                  <th className="px-4 py-2 text-right">% validation*</th>
                </tr>
              </thead>
              <tbody>
                {summary.byChannel.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-stone-500">
                      No attribution events yet.
                    </td>
                  </tr>
                ) : (
                  summary.byChannel.map((row) => (
                    <tr key={row.channel} className="border-t border-stone-100">
                      <td className="px-4 py-2 font-mono text-stone-800">{row.channel}</td>
                      <td className="px-4 py-2 text-right">{row.total}</td>
                      <td className="px-4 py-2 text-right text-emerald-800">{row.acquisition}</td>
                      <td className="px-4 py-2 text-right text-amber-800">{row.validation}</td>
                      <td className="px-4 py-2 text-right text-sky-800">{row.conversion}</td>
                      <td className="px-4 py-2 text-right text-stone-600">{row.mixed}</td>
                      <td className="px-4 py-2 text-right text-stone-500">{row.unknown}</td>
                      <td className="px-4 py-2 text-right font-mono">
                        {pct(row.validation_share_0_1)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="px-4 py-2 text-xs text-stone-500 border-t border-stone-100 bg-stone-50">
              *% validation = validation / (acquisition + validation). Conversion and unknown
              excluded from the denominator. <ArrowRight className="inline w-3 h-3" /> The
              higher this number, the more this channel is intake-not-acquisition.
            </div>
          </div>

          <div className="mt-6 text-xs text-stone-500">
            Latest classified: {summary.latestClassifiedAt ?? '(never)'} ·{' '}
            {summary.unclassifiedCount} of {summary.totalEvents} events still unclassified.
          </div>
        </>
      )}
    </div>
  )
}

interface RoleCardProps {
  label: string
  value: number
  hint?: string
  tone: 'neutral' | 'emerald' | 'amber' | 'sky' | 'stone'
}

function RoleCard({ label, value, hint, tone }: RoleCardProps) {
  const toneClasses: Record<RoleCardProps['tone'], string> = {
    neutral: 'bg-white border-stone-200 text-stone-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    sky: 'bg-sky-50 border-sky-200 text-sky-900',
    stone: 'bg-stone-50 border-stone-200 text-stone-700',
  }
  return (
    <div className={`p-3 border rounded-md ${toneClasses[tone]}`}>
      <div className="text-xs uppercase tracking-wide opacity-75">{label}</div>
      <div className="text-2xl font-serif">{value}</div>
      {hint && <div className="text-xs opacity-70">{hint}</div>}
    </div>
  )
}
