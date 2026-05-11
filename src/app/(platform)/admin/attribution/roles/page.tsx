'use client'

/**
 * Wave 7B — channel-role audit page (admin viewer).
 *
 * EXTENDED by Wave 16 (2026-05-11) with the orthogonal intent
 * dimension:
 *   - Per-channel intent column (targeted / broadcast / validation /
 *     unknown counts)
 *   - "The Knot broadcast reveal" headline card showing
 *     broadcast-share + conversion-rate-by-intent (the gold: targeted
 *     converts at X%, broadcast at Y%)
 *   - Filter pill row: All / Targeted only / Broadcast only / Unknown
 *     only (filters the per-channel split rows by which intent is
 *     non-zero in the row)
 *   - Reclassify-intent button alongside the reclassify-roles button
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *   - bloom-may9-llm-vs-template.md (Wave 16)
 *
 * Wave 7D will replace this with a richer discovery dashboard. This
 * is the minimal "the data is real, here's the split" view for both
 * the role AND intent forensic dimensions.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Compass,
  Megaphone,
  RefreshCw,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { IntentClassChip, type IntentClass } from '@/components/intel/IntentClassChip'

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

interface IntentConversionByIntent {
  targeted: number | null
  broadcast: number | null
  validation: number | null
  unknown: number | null
}

interface PerChannelIntentCounts {
  channel: string
  total: number
  targeted: number
  broadcast: number
  validation: number
  unknown: number
  broadcast_share_0_1: number | null
  conversion_by_intent: IntentConversionByIntent
}

interface IntentSummary {
  ok: boolean
  venueId: string
  totalEvents: number
  byIntent: Record<IntentClass, number>
  byChannel: PerChannelIntentCounts[]
  unclassifiedCount: number
  latestClassifiedAt: string | null
  error?: string
}

type IntentFilter = 'all' | 'targeted' | 'broadcast' | 'unknown'

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—'
  return `${Math.round(x * 100)}%`
}

export default function AttributionRolesPage() {
  const venueId = useVenueId()
  const [summary, setSummary] = useState<RoleSummary | null>(null)
  const [intentSummary, setIntentSummary] = useState<IntentSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)
  const [reclassifyingIntent, setReclassifyingIntent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intentFilter, setIntentFilter] = useState<IntentFilter>('all')

  const totalClassified = useMemo(() => {
    if (!summary) return 0
    return summary.totalEvents - (summary.unclassifiedCount ?? 0)
  }, [summary])

  const knotChannel = useMemo(() => {
    if (!summary) return null
    return summary.byChannel.find(
      (c) => c.channel === 'the_knot' || c.channel === 'theknot' || c.channel === 'theknot.com',
    )
  }, [summary])

  const knotIntent = useMemo(() => {
    if (!intentSummary) return null
    return intentSummary.byChannel.find(
      (c) => c.channel === 'the_knot' || c.channel === 'theknot' || c.channel === 'theknot.com',
    )
  }, [intentSummary])

  /** Map channel -> intent counts for the per-channel table extension. */
  const intentByChannel = useMemo(() => {
    const map = new Map<string, PerChannelIntentCounts>()
    if (intentSummary) {
      for (const c of intentSummary.byChannel) map.set(c.channel, c)
    }
    return map
  }, [intentSummary])

  /** Apply the filter to the role-summary channel rows. */
  const filteredChannels = useMemo(() => {
    if (!summary) return []
    if (intentFilter === 'all') return summary.byChannel
    return summary.byChannel.filter((row) => {
      const ic = intentByChannel.get(row.channel)
      if (!ic) return intentFilter === 'unknown'
      if (intentFilter === 'targeted') return ic.targeted > 0
      if (intentFilter === 'broadcast') return ic.broadcast > 0
      if (intentFilter === 'unknown') return ic.unknown > 0
      return true
    })
  }, [summary, intentByChannel, intentFilter])

  async function load() {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      // Wave 7B role summary + Wave 16 intent summary in parallel.
      const [roleRes, intentRes] = await Promise.all([
        fetch(`/api/admin/attribution/role-summary?venueId=${venueId}`),
        fetch(`/api/admin/attribution/intent/summary?venueId=${venueId}`),
      ])
      const roleJson = (await roleRes.json()) as RoleSummary
      const intentJson = (await intentRes.json()) as IntentSummary
      if (!roleRes.ok || !roleJson.ok) {
        setError(roleJson.error ?? `HTTP ${roleRes.status}`)
        return
      }
      setSummary(roleJson)
      if (intentRes.ok && intentJson.ok) {
        setIntentSummary(intentJson)
      } else {
        // Intent summary failure shouldn't gate role view.
        console.warn('intent summary failed:', intentJson.error)
      }
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

  async function reclassifyIntent(force: boolean) {
    if (!venueId) return
    setReclassifyingIntent(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/attribution/intent/reclassify', {
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
      setReclassifyingIntent(false)
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
          <h1 className="text-3xl font-serif text-stone-900 mb-2">Channel-Role &amp; Intent Audit</h1>
          <p className="text-stone-600 max-w-3xl">
            Two orthogonal forensic dimensions. <span className="font-semibold">Role</span>{' '}
            answers &ldquo;did this channel actually source the couple?&rdquo; (
            <span className="text-emerald-700 font-semibold">acquisition</span> /{' '}
            <span className="text-amber-700 font-semibold">validation</span> /{' '}
            <span className="text-sky-700 font-semibold">conversion</span>).{' '}
            <span className="font-semibold">Intent</span> answers &ldquo;did the couple actively
            choose us, or did the platform&apos;s algorithm push us into a multi-venue blast?&rdquo;
            (<span className="text-emerald-700 font-semibold">targeted</span> /{' '}
            <span className="text-orange-700 font-semibold">broadcast</span>).
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => reclassify(false)}
            disabled={reclassifying || !venueId}
            className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${reclassifying ? 'animate-spin' : ''}`} />
            {reclassifying ? 'Classifying roles…' : 'Reclassify roles (50)'}
          </button>
          <button
            onClick={() => reclassifyIntent(false)}
            disabled={reclassifyingIntent || !venueId}
            className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Megaphone className={`w-4 h-4 ${reclassifyingIntent ? 'animate-pulse' : ''}`} />
            {reclassifyingIntent ? 'Classifying intent…' : 'Reclassify intent (50)'}
          </button>
        </div>
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
        <div className="text-stone-500">Loading role + intent summary…</div>
      )}

      {summary && (
        <>
          {/* Wave 7B headline: validation share for Knot. */}
          {knotChannel && (
            <div className="mb-6 p-6 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2 text-amber-900">
                <Compass className="w-5 h-5" />
                <span className="font-serif text-lg">The Knot role reveal</span>
              </div>
              <div className="text-3xl font-serif text-stone-900 mb-1">
                {pct(knotChannel.validation_share_0_1)} of{' '}
                <span className="font-mono text-2xl">the_knot</span> attributions are{' '}
                <span className="text-amber-700 font-semibold">validation</span>, not acquisition.
              </div>
              <div className="text-sm text-stone-700">
                {knotChannel.validation} of {knotChannel.acquisition + knotChannel.validation}{' '}
                Knot touchpoints (excluding conversions and unclassified) were classified as
                couples who discovered the venue elsewhere and used Knot as the intake form.
              </div>
            </div>
          )}

          {/* Wave 16 headline: broadcast share + conversion-by-intent for Knot. */}
          {knotIntent && (knotIntent.targeted > 0 || knotIntent.broadcast > 0) && (
            <div className="mb-6 p-6 bg-orange-50 border border-orange-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2 text-orange-900">
                <Megaphone className="w-5 h-5" />
                <span className="font-serif text-lg">The Knot broadcast reveal</span>
              </div>
              <div className="text-3xl font-serif text-stone-900 mb-1">
                {pct(knotIntent.broadcast_share_0_1)} of <span className="font-mono text-2xl">the_knot</span>{' '}
                inquiries are{' '}
                <span className="text-orange-700 font-semibold">broadcast</span>{' '}
                (auto-distributed), not <span className="text-emerald-700 font-semibold">targeted</span>.
              </div>
              <div className="text-sm text-stone-700 mb-3">
                {knotIntent.broadcast} of {knotIntent.targeted + knotIntent.broadcast}{' '}
                classified Knot inquiries matched the &ldquo;Inquire to similar venues&rdquo;
                broadcast template AND showed zero post-inquiry engagement — the couple did
                not actively pick us; Knot&apos;s ranker bcc&apos;d us into a multi-venue blast.
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
                <div className="bg-white border border-emerald-200 rounded p-3">
                  <div className="text-emerald-700 font-semibold">Targeted</div>
                  <div className="text-2xl font-serif text-stone-900">
                    {pct(knotIntent.conversion_by_intent.targeted)}
                  </div>
                  <div className="text-xs text-stone-500">conversion to booked</div>
                </div>
                <div className="bg-white border border-orange-200 rounded p-3">
                  <div className="text-orange-700 font-semibold">Broadcast</div>
                  <div className="text-2xl font-serif text-stone-900">
                    {pct(knotIntent.conversion_by_intent.broadcast)}
                  </div>
                  <div className="text-xs text-stone-500">conversion to booked</div>
                </div>
                <div className="bg-white border border-stone-200 rounded p-3">
                  <div className="text-stone-700 font-semibold">Unknown</div>
                  <div className="text-2xl font-serif text-stone-900">
                    {pct(knotIntent.conversion_by_intent.unknown)}
                  </div>
                  <div className="text-xs text-stone-500">not yet classified</div>
                </div>
              </div>
              <div className="text-xs text-stone-500 mt-3">
                Spend strategy: broadcast inquiries should NOT carry full Knot-CAC weight. They
                are closer to paid impressions than inbound leads.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <RoleCard label="Total events" value={summary.totalEvents} tone="neutral" />
            <RoleCard
              label="Classified (role)"
              value={totalClassified}
              hint={`${pct(summary.totalEvents > 0 ? totalClassified / summary.totalEvents : null)} coverage`}
              tone="neutral"
            />
            <RoleCard label="Acquisition" value={summary.byRole.acquisition ?? 0} tone="emerald" />
            <RoleCard label="Validation" value={summary.byRole.validation ?? 0} tone="amber" />
            <RoleCard label="Conversion" value={summary.byRole.conversion ?? 0} tone="sky" />
            <RoleCard label="Unknown (role)" value={summary.byRole.unknown ?? 0} tone="stone" />
          </div>

          {/* Intent dimension counts */}
          {intentSummary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <RoleCard
                label="Targeted (intent)"
                value={intentSummary.byIntent.targeted ?? 0}
                tone="emerald"
              />
              <RoleCard
                label="Broadcast (intent)"
                value={intentSummary.byIntent.broadcast ?? 0}
                tone="orange"
              />
              <RoleCard
                label="Validation (intent)"
                value={intentSummary.byIntent.validation ?? 0}
                tone="amber"
              />
              <RoleCard
                label="Unknown (intent)"
                value={intentSummary.byIntent.unknown ?? 0}
                tone="stone"
              />
            </div>
          )}

          {/* Filter pill row */}
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-stone-500">Filter by intent:</span>
            {(['all', 'targeted', 'broadcast', 'unknown'] as IntentFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setIntentFilter(f)}
                className={`px-3 py-1 rounded-full border ${
                  intentFilter === f
                    ? 'bg-stone-900 text-white border-stone-900'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-50'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Per-channel breakdown */}
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-stone-200 bg-stone-50">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-stone-600" />
                <span className="font-medium text-stone-900">Per-channel split (role + intent)</span>
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
                  <th className="px-4 py-2 text-left">Intent split</th>
                  <th className="px-4 py-2 text-right">% broadcast*</th>
                </tr>
              </thead>
              <tbody>
                {filteredChannels.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-6 text-center text-stone-500">
                      No matching channels.
                    </td>
                  </tr>
                ) : (
                  filteredChannels.map((row) => {
                    const ic = intentByChannel.get(row.channel)
                    return (
                      <tr key={row.channel} className="border-t border-stone-100">
                        <td className="px-4 py-2 font-mono text-stone-800">{row.channel}</td>
                        <td className="px-4 py-2 text-right">{row.total}</td>
                        <td className="px-4 py-2 text-right text-emerald-800">
                          {row.acquisition}
                        </td>
                        <td className="px-4 py-2 text-right text-amber-800">{row.validation}</td>
                        <td className="px-4 py-2 text-right text-sky-800">{row.conversion}</td>
                        <td className="px-4 py-2 text-right text-stone-600">{row.mixed}</td>
                        <td className="px-4 py-2 text-right text-stone-500">{row.unknown}</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {pct(row.validation_share_0_1)}
                        </td>
                        <td className="px-4 py-2 text-left">
                          {ic ? (
                            <div className="flex flex-wrap gap-1">
                              {ic.targeted > 0 && (
                                <IntentClassChip
                                  intentClass="targeted"
                                  title={`${ic.targeted} targeted`}
                                />
                              )}
                              {ic.broadcast > 0 && (
                                <IntentClassChip
                                  intentClass="broadcast"
                                  templateScore={null}
                                  title={`${ic.broadcast} broadcast`}
                                />
                              )}
                              {ic.validation > 0 && (
                                <IntentClassChip
                                  intentClass="validation"
                                  title={`${ic.validation} validation`}
                                />
                              )}
                              {ic.unknown > 0 && (
                                <IntentClassChip
                                  intentClass="unknown"
                                  title={`${ic.unknown} unknown`}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-orange-700">
                          {ic ? pct(ic.broadcast_share_0_1) : '—'}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
            <div className="px-4 py-2 text-xs text-stone-500 border-t border-stone-100 bg-stone-50">
              *% validation = validation / (acquisition + validation); *% broadcast =
              broadcast / (targeted + broadcast). Higher = channel is more intake-not-
              acquisition (role) or more platform-pushed-not-couple-chosen (intent).{' '}
              <ArrowRight className="inline w-3 h-3" /> The two dimensions are orthogonal:
              a row can be high on both, neither, or one but not the other.
            </div>
          </div>

          <div className="mt-6 text-xs text-stone-500">
            Role latest: {summary.latestClassifiedAt ?? '(never)'} ·{' '}
            {summary.unclassifiedCount} of {summary.totalEvents} unclassified.
            {intentSummary && (
              <>
                {' '}
                · Intent latest: {intentSummary.latestClassifiedAt ?? '(never)'} ·{' '}
                {intentSummary.unclassifiedCount} of {intentSummary.totalEvents} unclassified.
              </>
            )}
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
  tone: 'neutral' | 'emerald' | 'amber' | 'sky' | 'stone' | 'orange'
}

function RoleCard({ label, value, hint, tone }: RoleCardProps) {
  const toneClasses: Record<RoleCardProps['tone'], string> = {
    neutral: 'bg-white border-stone-200 text-stone-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    sky: 'bg-sky-50 border-sky-200 text-sky-900',
    stone: 'bg-stone-50 border-stone-200 text-stone-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-900',
  }
  return (
    <div className={`p-3 border rounded-md ${toneClasses[tone]}`}>
      <div className="text-xs uppercase tracking-wide opacity-75">{label}</div>
      <div className="text-2xl font-serif">{value}</div>
      {hint && <div className="text-xs opacity-70">{hint}</div>}
    </div>
  )
}
