'use client'

/**
 * Wave 5D — venue thesis dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D — onboarding bootstrap; thesis is
 *     what the operator reads on first venue login)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *
 * Read-only coordinator surface that surfaces the current venue's
 * thesis. The operator_brief_paragraph + venue_archetype label is the
 * lede; everything else expands the supporting evidence. Sidebar shows
 * cross-venue overlaps when other venues' theses exist.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Compass,
  Heart,
  RefreshCw,
  Sparkles,
  Target,
  Users,
  Volume2,
  Wrench,
  Layers,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface VenueArchetype {
  label: string
  description: string
  evidence_summary: string
  confidence_0_100: number
}

interface OverIndexedPersona {
  persona_label: string
  share_pct: number
  vs_market_baseline_pct: number | null
  evidence: string
}

interface RecurringEmotionalLandscape {
  theme: string
  n_couples: number
  non_sensitive_summary: string
}

interface ConversionSignal {
  signal: string
  lift_pct: number
  evidence: string
}

interface VoiceThesis {
  tone_descriptors: string[]
  language_that_lands: string[]
  language_to_avoid: string[]
  key_principles: string[]
}

interface ServiceDemandStrength {
  offering: string
  demand_signal: string
}

interface ServiceDemandGap {
  missing_offering: string
  evidence_of_demand: string
  investment_recommendation: string
}

interface VenueThesisOutput {
  venue_archetype: VenueArchetype
  over_indexed_personas: OverIndexedPersona[]
  recurring_emotional_landscape: RecurringEmotionalLandscape[]
  conversion_signature: ConversionSignal[]
  voice_thesis: VoiceThesis
  service_demand_strengths: ServiceDemandStrength[]
  service_demand_gaps: ServiceDemandGap[]
  operator_brief_paragraph: string
  cohort_size_at_generation: number
  refusals: Array<{ field: string; reason: string }>
}

interface ThesisPayload {
  ok: boolean
  venueId: string
  thesis: VenueThesisOutput
  couplesAtGeneration: number
  generationCount?: number
  lastGeneratedAt?: string
  promptVersion: string
  cumulativeCostCents?: number
  error?: string
}

interface SharedItem {
  label: string
  anchor_context?: string
  peer_context?: string
}

interface OverlapJsonb {
  anchor_venue_label: string | null
  peer_venue_label: string | null
  shared_persona_archetypes: SharedItem[]
  shared_emerging_themes: SharedItem[]
  shared_service_demand_gaps: SharedItem[]
  shared_voice_principles: SharedItem[]
  computation_notes: string
}

interface CrossVenueOverlap {
  anchorVenueId: string
  peerVenueId: string
  peerVenueLabel: string | null
  overlapJsonb: OverlapJsonb
  confidence0to100: number
  computedAt: string
}

interface OverlapPayload {
  ok: boolean
  anchorVenueId: string
  overlaps: CrossVenueOverlap[]
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${Math.round(n)}%`
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function VenueThesisPage() {
  const venueId = useVenueId()
  const [payload, setPayload] = useState<ThesisPayload | null>(null)
  const [overlapPayload, setOverlapPayload] = useState<OverlapPayload | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cohortReady = useMemo(() => {
    if (!payload?.thesis) return false
    return payload.thesis.cohort_size_at_generation > 0
  }, [payload])

  async function load() {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const [thesisRes, overlapRes] = await Promise.all([
        fetch(`/api/admin/onboarding/venue-thesis?venueId=${venueId}`),
        fetch(
          `/api/admin/onboarding/venue-thesis/cross-venue-overlap?venueId=${venueId}`,
        ),
      ])
      if (thesisRes.status === 404) {
        setPayload(null)
      } else {
        const t = (await thesisRes.json()) as ThesisPayload
        if (!t.ok) {
          setError(t.error ?? `HTTP ${thesisRes.status}`)
        } else {
          setPayload(t)
        }
      }
      if (overlapRes.ok) {
        const o = (await overlapRes.json()) as OverlapPayload
        if (o.ok) setOverlapPayload(o)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function regenerate() {
    if (!venueId) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/onboarding/venue-thesis/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const json = (await res.json()) as ThesisPayload
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
      } else {
        await load()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  async function recomputeOverlap() {
    if (!venueId) return
    try {
      await fetch(
        '/api/admin/onboarding/venue-thesis/cross-venue-overlap',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
          <h1 className="text-3xl font-serif text-stone-900 mb-2">
            Venue Thesis
          </h1>
          <p className="text-stone-600 max-w-3xl">
            Strategic identity reconstructed from your data. What this venue
            actually is — based on the cohort, not on a brand brief. Onboarding
            should never start blank: once Bloom has read enough couples, the
            thesis tells you what you over-index on, what voice resonates, and
            what services to invest in.
          </p>
        </div>
        <button
          onClick={regenerate}
          disabled={generating || !venueId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw
            className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`}
          />
          {generating ? 'Synthesising…' : 'Regenerate'}
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

      {loading && !payload && (
        <div className="text-stone-500">Loading thesis…</div>
      )}

      {!loading && !payload && (
        <div className="p-8 bg-stone-50 border border-stone-200 rounded-lg text-center">
          <Sparkles className="w-8 h-8 mx-auto text-stone-400 mb-3" />
          <div className="font-serif text-xl text-stone-900 mb-2">
            No thesis yet
          </div>
          <div className="text-sm text-stone-600 mb-4 max-w-lg mx-auto">
            The venue thesis synthesises your couple cohort into a strategic
            identity doc. Run a generation once Wave 4 has reconstructed at
            least a handful of couples.
          </div>
          <button
            onClick={regenerate}
            disabled={generating || !venueId}
            className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            Generate first thesis
          </button>
        </div>
      )}

      {payload && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Headline: archetype */}
            <div className="p-6 bg-gradient-to-br from-sage-50 to-warm-white border border-sage-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2 text-sage-800">
                <Compass className="w-5 h-5" />
                <span className="text-sm uppercase tracking-wide">
                  Venue archetype
                </span>
                <span className="ml-auto text-xs text-stone-500">
                  Confidence{' '}
                  <span className="font-mono">
                    {payload.thesis.venue_archetype.confidence_0_100}
                  </span>
                  /100
                </span>
              </div>
              <div className="text-3xl font-serif text-stone-900 mb-2">
                {payload.thesis.venue_archetype.label}
              </div>
              <div className="text-stone-700 mb-3">
                {payload.thesis.venue_archetype.description}
              </div>
              <div className="text-sm text-stone-500 italic">
                {payload.thesis.venue_archetype.evidence_summary}
              </div>
            </div>

            {/* Operator brief */}
            <div className="p-6 bg-white border border-stone-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3 text-stone-700">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm uppercase tracking-wide">
                  Operator brief
                </span>
              </div>
              <p className="text-base text-stone-800 leading-relaxed">
                {payload.thesis.operator_brief_paragraph}
              </p>
            </div>

            {/* Over-indexed personas */}
            <Section
              icon={<Users className="w-4 h-4" />}
              title="Over-indexed personas"
              empty={payload.thesis.over_indexed_personas.length === 0}
              emptyHint="No persona over-indexes vs market — or no market baseline yet."
            >
              <div className="space-y-3">
                {payload.thesis.over_indexed_personas.map((p, i) => (
                  <div
                    key={i}
                    className="p-3 bg-stone-50 border border-stone-200 rounded-md"
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="font-semibold text-stone-900">
                        {p.persona_label}
                      </span>
                      <span className="text-sm text-stone-600">
                        {Math.round(p.share_pct)}% of cohort
                        {p.vs_market_baseline_pct !== null &&
                          ` · ${fmtPct(p.share_pct - p.vs_market_baseline_pct)} vs market`}
                      </span>
                    </div>
                    <div className="text-sm text-stone-700">{p.evidence}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Recurring emotional landscape */}
            <Section
              icon={<Heart className="w-4 h-4" />}
              title="Recurring emotional landscape"
              empty={payload.thesis.recurring_emotional_landscape.length === 0}
              emptyHint="Cohort hasn't surfaced repeating emotional themes (or sample is too small)."
            >
              <div className="space-y-3">
                {payload.thesis.recurring_emotional_landscape.map((r, i) => (
                  <div
                    key={i}
                    className="p-3 bg-stone-50 border border-stone-200 rounded-md"
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="font-semibold text-stone-900">
                        {r.theme}
                      </span>
                      <span className="text-sm text-stone-500">
                        {r.n_couples} couples
                      </span>
                    </div>
                    <div className="text-sm text-stone-700">
                      {r.non_sensitive_summary}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Conversion signature */}
            <Section
              icon={<Target className="w-4 h-4" />}
              title="Conversion signature"
              empty={payload.thesis.conversion_signature.length === 0}
              emptyHint="No clear conversion-correlation signals yet."
            >
              <div className="space-y-3">
                {payload.thesis.conversion_signature.map((c, i) => (
                  <div
                    key={i}
                    className="p-3 bg-emerald-50 border border-emerald-200 rounded-md"
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="font-semibold text-emerald-900">
                        {c.signal}
                      </span>
                      <span className="text-sm font-mono text-emerald-700">
                        lift {fmtPct(c.lift_pct)}
                      </span>
                    </div>
                    <div className="text-sm text-emerald-900/80">
                      {c.evidence}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Voice thesis */}
            <Section
              icon={<Volume2 className="w-4 h-4" />}
              title="Voice thesis"
              empty={
                payload.thesis.voice_thesis.tone_descriptors.length === 0 &&
                payload.thesis.voice_thesis.language_that_lands.length === 0 &&
                payload.thesis.voice_thesis.language_to_avoid.length === 0 &&
                payload.thesis.voice_thesis.key_principles.length === 0
              }
              emptyHint="Voice thesis pending — needs more cohort signal."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <VoiceList
                  label="Tone descriptors"
                  items={payload.thesis.voice_thesis.tone_descriptors}
                  tone="neutral"
                />
                <VoiceList
                  label="Key principles"
                  items={payload.thesis.voice_thesis.key_principles}
                  tone="neutral"
                />
                <VoiceList
                  label="Language that lands"
                  items={payload.thesis.voice_thesis.language_that_lands}
                  tone="emerald"
                />
                <VoiceList
                  label="Language to avoid"
                  items={payload.thesis.voice_thesis.language_to_avoid}
                  tone="amber"
                />
              </div>
            </Section>

            {/* Service demand strengths */}
            <Section
              icon={<Sparkles className="w-4 h-4" />}
              title="Service demand strengths"
              empty={payload.thesis.service_demand_strengths.length === 0}
              emptyHint="No clear service-strength signals yet."
            >
              <div className="space-y-2">
                {payload.thesis.service_demand_strengths.map((s, i) => (
                  <div
                    key={i}
                    className="p-3 bg-emerald-50 border border-emerald-200 rounded-md"
                  >
                    <div className="font-semibold text-emerald-900">
                      {s.offering}
                    </div>
                    <div className="text-sm text-emerald-900/80">
                      {s.demand_signal}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Service demand gaps */}
            <Section
              icon={<Wrench className="w-4 h-4" />}
              title="Service demand gaps"
              empty={payload.thesis.service_demand_gaps.length === 0}
              emptyHint="No unmet demand surfaced yet."
            >
              <div className="space-y-2">
                {payload.thesis.service_demand_gaps.map((g, i) => (
                  <div
                    key={i}
                    className="p-3 bg-amber-50 border border-amber-200 rounded-md"
                  >
                    <div className="font-semibold text-amber-900">
                      {g.missing_offering}
                    </div>
                    <div className="text-sm text-amber-900/80 mb-1">
                      {g.evidence_of_demand}
                    </div>
                    <div className="text-sm font-medium text-amber-900">
                      → {g.investment_recommendation}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Refusals */}
            {payload.thesis.refusals.length > 0 && (
              <Section
                icon={<AlertCircle className="w-4 h-4" />}
                title="Refusals (audit trail)"
                empty={false}
              >
                <div className="space-y-1">
                  {payload.thesis.refusals.map((r, i) => (
                    <div
                      key={i}
                      className="text-sm text-stone-600 font-mono"
                    >
                      <span className="text-stone-400">[{r.field}]</span>{' '}
                      {r.reason}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          {/* Sidebar — cross-venue overlap + footer */}
          <div className="space-y-4">
            <div className="p-4 bg-white border border-stone-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3 text-stone-700">
                <Layers className="w-4 h-4" />
                <span className="text-sm uppercase tracking-wide">
                  Cross-venue overlap
                </span>
                <button
                  onClick={recomputeOverlap}
                  className="ml-auto text-xs text-stone-500 hover:text-stone-700 underline"
                >
                  Recompute
                </button>
              </div>
              {!overlapPayload ||
              overlapPayload.overlaps.length === 0 ? (
                <div className="text-sm text-stone-500">
                  No peer venues with a thesis yet. At Wedgewood scale (100+
                  venues), this surface shows shared archetypes, themes, and
                  demand gaps across venue boundaries — at aggregate level
                  only. Privacy doctrine: aggregate ≠ disclose.
                </div>
              ) : (
                <div className="space-y-3">
                  {overlapPayload.overlaps.map((o) => (
                    <div
                      key={o.peerVenueId}
                      className="p-3 bg-stone-50 border border-stone-200 rounded-md"
                    >
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="font-semibold text-stone-900 text-sm">
                          {o.peerVenueLabel ?? o.peerVenueId.slice(0, 8)}
                        </span>
                        <span className="text-xs font-mono text-stone-500">
                          {o.confidence0to100}/100
                        </span>
                      </div>
                      {o.overlapJsonb.shared_persona_archetypes.length > 0 && (
                        <div className="text-xs text-stone-600 mb-1">
                          <span className="text-stone-500">archetypes:</span>{' '}
                          {o.overlapJsonb.shared_persona_archetypes
                            .map((s) => s.label)
                            .join(', ')}
                        </div>
                      )}
                      {o.overlapJsonb.shared_emerging_themes.length > 0 && (
                        <div className="text-xs text-stone-600 mb-1">
                          <span className="text-stone-500">themes:</span>{' '}
                          {o.overlapJsonb.shared_emerging_themes
                            .map((s) => s.label)
                            .join(', ')}
                        </div>
                      )}
                      {o.overlapJsonb.shared_service_demand_gaps.length > 0 && (
                        <div className="text-xs text-stone-600 mb-1">
                          <span className="text-stone-500">gaps:</span>{' '}
                          {o.overlapJsonb.shared_service_demand_gaps
                            .map((s) => s.label)
                            .join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Generation metadata */}
            <div className="p-4 bg-stone-50 border border-stone-200 rounded-lg text-xs text-stone-600 space-y-1">
              <div>
                <span className="text-stone-500">Cohort size:</span>{' '}
                <span className="font-mono">
                  {payload.thesis.cohort_size_at_generation}
                </span>{' '}
                couples
              </div>
              <div>
                <span className="text-stone-500">Last generated:</span>{' '}
                {fmtDate(payload.lastGeneratedAt)}
              </div>
              {payload.generationCount !== undefined && (
                <div>
                  <span className="text-stone-500">Generation count:</span>{' '}
                  <span className="font-mono">{payload.generationCount}</span>
                </div>
              )}
              <div>
                <span className="text-stone-500">Prompt version:</span>{' '}
                <span className="font-mono">{payload.promptVersion}</span>
              </div>
              {payload.cumulativeCostCents !== undefined && (
                <div>
                  <span className="text-stone-500">Cumulative cost:</span>{' '}
                  <span className="font-mono">
                    ${(payload.cumulativeCostCents / 100).toFixed(4)}
                  </span>
                </div>
              )}
              {!cohortReady && (
                <div className="mt-2 pt-2 border-t border-stone-200 text-amber-700">
                  Cohort empty — thesis is the placeholder shape. Generate
                  again once couples are reconstructed.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  empty,
  emptyHint,
  children,
}: {
  icon: React.ReactNode
  title: string
  empty: boolean
  emptyHint?: string
  children?: React.ReactNode
}) {
  return (
    <div className="p-5 bg-white border border-stone-200 rounded-lg">
      <div className="flex items-center gap-2 mb-3 text-stone-700">
        {icon}
        <span className="text-sm uppercase tracking-wide">{title}</span>
      </div>
      {empty ? (
        <div className="text-sm text-stone-500 italic">
          {emptyHint ?? 'No data yet.'}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

interface VoiceListProps {
  label: string
  items: string[]
  tone: 'neutral' | 'emerald' | 'amber'
}

function VoiceList({ label, items, tone }: VoiceListProps) {
  const toneClasses = {
    neutral: 'bg-stone-50 border-stone-200 text-stone-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
  }
  return (
    <div className={`p-3 border rounded-md ${toneClasses[tone]}`}>
      <div className="text-xs uppercase tracking-wide opacity-75 mb-2">
        {label}
      </div>
      {items.length === 0 ? (
        <div className="text-xs italic opacity-60">(none)</div>
      ) : (
        <ul className="text-sm space-y-1 list-disc pl-5">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
