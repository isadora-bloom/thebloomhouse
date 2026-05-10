'use client'

/**
 * Wave 6D — reusable weekly digest display.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6D weekly digest narrative
 * surface).
 *
 * Embeddable on:
 *   - /intel/marketing-roi/digest (dedicated digest page)
 *   - any future weekly-summary surface (sidebar widget, email body)
 *
 * AUTO-FLAG NEVER AUTO-EXECUTE: this component RENDERS the narrative
 * + structured re-emission. Action buttons live elsewhere (digest
 * page's "Build new digest" + future "Send via email" wiring).
 */

import { AlertTriangle, AlertCircle, ArrowDown, ArrowUp } from 'lucide-react'

export interface DigestFlagSummary {
  title: string
  severity: 'info' | 'warning' | 'critical'
  recommended_action: string | null
}

export interface DigestRecommendationSummary {
  title: string
  projected_impact_cents: number | null
}

export interface DigestWeekOverWeek {
  cac_change_pct: number | null
  conversion_change_pct: number | null
  roi_change_pct: number | null
}

export interface DigestAbTestConcluded {
  name: string
  winner: 'variant_a' | 'variant_b' | 'inconclusive'
  lift_pct: number | null
}

export interface DigestValidatedDiscovery {
  title: string
  summary: string
}

export interface DigestPayload {
  headline: string
  this_week_in_3_sentences: string
  top_flags: DigestFlagSummary[]
  top_recommendations: DigestRecommendationSummary[]
  week_over_week: DigestWeekOverWeek
  ab_tests_concluded: DigestAbTestConcluded[]
  validated_discoveries: DigestValidatedDiscovery[]
  refusal: string | null
}

export interface MarketingDigestProps {
  digest: DigestPayload
  periodStart?: string
  periodEnd?: string
  generatedAt?: string
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const abs = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : '+'
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function severityBadge(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-rose-100 text-rose-800 border-rose-200'
    case 'warning':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'info':
    default:
      return 'bg-sky-100 text-sky-800 border-sky-200'
  }
}

function DeltaCell({
  label,
  pct,
  invertColor,
}: {
  label: string
  pct: number | null
  invertColor?: boolean
}) {
  if (pct === null) {
    return (
      <div className="rounded-md border border-stone-200 bg-white p-3">
        <div className="text-[11px] uppercase tracking-wide text-stone-500">
          {label}
        </div>
        <div className="mt-1 text-lg text-stone-400">—</div>
      </div>
    )
  }
  // For CAC, lower is better → invert color so a decrease shows green.
  const isPositive = invertColor ? pct < 0 : pct > 0
  const isNegative = invertColor ? pct > 0 : pct < 0
  const colorClass = isPositive
    ? 'text-emerald-700'
    : isNegative
      ? 'text-rose-700'
      : 'text-stone-700'
  const Arrow = pct >= 0 ? ArrowUp : ArrowDown
  return (
    <div className="rounded-md border border-stone-200 bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-stone-500">
        {label}
      </div>
      <div
        className={`mt-1 inline-flex items-center gap-1 text-lg font-semibold tabular-nums ${colorClass}`}
      >
        <Arrow className="h-4 w-4" />
        {pct >= 0 ? '+' : ''}
        {pct.toFixed(1)}%
      </div>
    </div>
  )
}

export function MarketingDigest({
  digest,
  periodStart,
  periodEnd,
  generatedAt,
}: MarketingDigestProps) {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {periodStart && periodEnd ? (
          <div className="text-xs text-stone-500">
            Week of {periodStart} → {periodEnd}
            {generatedAt ? (
              <span className="ml-2">
                · generated{' '}
                {new Date(generatedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        <h2 className="font-serif text-2xl text-stone-900">{digest.headline}</h2>
        <p className="text-base leading-relaxed text-stone-700">
          {digest.this_week_in_3_sentences}
        </p>
        {digest.refusal ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mr-2 inline h-4 w-4 align-baseline" />
            {digest.refusal}
          </div>
        ) : null}
      </header>

      {/* Top flags */}
      {digest.top_flags.length > 0 ? (
        <section>
          <h3 className="mb-2 font-serif text-lg text-stone-900">
            Top flags this week
          </h3>
          <div className="space-y-2">
            {digest.top_flags.map((f, i) => (
              <div
                key={i}
                className="rounded-md border border-stone-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${severityBadge(f.severity)}`}
                  >
                    {f.severity === 'critical' ? (
                      <AlertCircle className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {f.severity.toUpperCase()}
                  </span>
                  <span className="font-medium text-stone-900">{f.title}</span>
                </div>
                {f.recommended_action ? (
                  <div className="mt-1 text-sm text-stone-700">
                    {f.recommended_action}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Top recommendations */}
      {digest.top_recommendations.length > 0 ? (
        <section>
          <h3 className="mb-2 font-serif text-lg text-stone-900">
            Top reallocation recommendations
          </h3>
          <div className="space-y-2">
            {digest.top_recommendations.map((r, i) => (
              <div
                key={i}
                className="flex items-start justify-between gap-3 rounded-md border border-stone-200 bg-white p-3"
              >
                <div className="flex-1 text-sm text-stone-800">{r.title}</div>
                {r.projected_impact_cents !== null ? (
                  <div
                    className={`text-base font-semibold tabular-nums ${
                      r.projected_impact_cents > 0
                        ? 'text-emerald-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {formatCents(r.projected_impact_cents)}/mo
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Week-over-week */}
      <section>
        <h3 className="mb-2 font-serif text-lg text-stone-900">
          Week-over-week
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DeltaCell
            label="CAC change"
            pct={digest.week_over_week.cac_change_pct}
            invertColor
          />
          <DeltaCell
            label="Conversion change"
            pct={digest.week_over_week.conversion_change_pct}
          />
          <DeltaCell
            label="ROI change"
            pct={digest.week_over_week.roi_change_pct}
          />
        </div>
      </section>

      {/* A/B tests */}
      {digest.ab_tests_concluded.length > 0 ? (
        <section>
          <h3 className="mb-2 font-serif text-lg text-stone-900">
            A/B tests concluded
          </h3>
          <div className="space-y-2">
            {digest.ab_tests_concluded.map((t, i) => (
              <div
                key={i}
                className="flex items-start justify-between gap-3 rounded-md border border-stone-200 bg-white p-3"
              >
                <div className="flex-1 text-sm text-stone-800">{t.name}</div>
                <div className="text-right">
                  <div className="text-sm font-medium text-stone-900">
                    {t.winner === 'variant_a'
                      ? 'A wins'
                      : t.winner === 'variant_b'
                        ? 'B wins'
                        : 'Inconclusive'}
                  </div>
                  {t.lift_pct !== null ? (
                    <div className="text-xs text-stone-500">
                      lift {t.lift_pct.toFixed(1)}%
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Validated discoveries */}
      {digest.validated_discoveries.length > 0 ? (
        <section>
          <h3 className="mb-2 font-serif text-lg text-stone-900">
            Validated discoveries this week
          </h3>
          <div className="space-y-2">
            {digest.validated_discoveries.map((d, i) => (
              <div
                key={i}
                className="rounded-md border border-stone-200 bg-white p-3"
              >
                <div className="text-sm font-medium text-stone-900">
                  {d.title}
                </div>
                <div className="mt-1 text-sm text-stone-700">{d.summary}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
