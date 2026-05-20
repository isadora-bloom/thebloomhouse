'use client'

/**
 * Identity Report tab — Tier 8 §C.5 (Q6/29/30/36).
 *
 * Reads /api/admin/intel/identity-report and renders four sections:
 *
 *  Q6  — couples summary: total + booked + resolved + ghost + channel-
 *        scoped, fragments total + unpromoted, promotion rate. The
 *        candidate-match confidence distribution by tier × resolution
 *        is rendered as a small grid so the operator can see how
 *        often Bloom's tiers actually got confirmed vs rejected.
 *  Q29 — top 20 highest-confidence and 20 lowest-confidence merges
 *        from couple_merge_events, with both sides and the reason
 *        rendered. The operator can spot a wrong high-confidence call
 *        or a right low-confidence call by reading the labels.
 *  Q30 — last-90-day completeness scoring: count of couples in each
 *        of {Complete / Mostly complete / Partial / Minimal} buckets,
 *        plus per-dimension presence so the operator sees which
 *        dimension is most often missing.
 *  Q36 — 5 most-confident "same" decisions + 5 borderline pending
 *        decisions side-by-side, so the operator can verify the
 *        precision (top-5 should all be obviously same) and the
 *        borderline calls (you may agree / disagree on either side).
 *
 * Honesty (§C.6 Tier 4): empty cells say so out loud ("no merges
 * recorded yet" rather than rendering zeros that look like a confident
 * answer). No fake-zero percentages.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Users,
  GitMerge,
  CheckSquare,
  AlertTriangle,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import type {
  IdentityReport,
  IdentityReportMerge,
  IdentityReportPending,
} from '@/lib/services/identity/identity-report'

interface ApiResponse {
  ok: boolean
  venueName?: string
  report?: IdentityReport
  error?: string
}

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function fmtPct(p: number | null): string {
  if (p === null) return '—'
  return `${Math.round(p * 100)}%`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

function tierBadgeClass(tier: 'high' | 'medium' | 'low' | null): string {
  if (tier === 'high') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (tier === 'medium') return 'bg-amber-100 text-amber-800 border-amber-200'
  if (tier === 'low') return 'bg-stone-100 text-stone-700 border-stone-200'
  return 'bg-stone-100 text-stone-500 border-stone-200'
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="bg-white border border-stone-200 rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-stone-200 flex items-center gap-2">
        <span className="text-stone-500">{icon}</span>
        <h2 className="text-base font-semibold text-stone-900">{title}</h2>
        {hint && <span className="text-xs text-stone-500 ml-auto">{hint}</span>}
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  )
}

function MetaCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg px-4 py-3">
      <div className="text-xs text-stone-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl text-stone-900 mt-1">{value}</div>
      {hint && <div className="text-[11px] text-stone-500 mt-0.5">{hint}</div>}
    </div>
  )
}

export default function IdentityReportTab() {
  const [data, setData] = useState<IdentityReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/identity-report', {
        cache: 'no-store',
      })
      const body: ApiResponse = await res.json()
      if (!body.ok || !body.report) {
        setError(body.error ?? 'Failed to load identity report')
      } else {
        setData(body.report)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-stone-600 px-2 py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading identity report…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-sm">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <div className="font-medium">Could not load identity report</div>
          <div className="text-rose-700 mt-0.5">{error}</div>
        </div>
      </div>
    )
  }

  if (!data) return null

  const { couples, confidenceDistribution, completeness } = data

  return (
    <div className="space-y-6">
      {/* Q6 — couples summary + confidence distribution */}
      <Section
        icon={<Users className="w-4 h-4" />}
        title="Couples & identity confidence"
        hint="Q6 — how many unique couples does Bloom see, and how confident is it?"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <MetaCard
            label="Engaged couples"
            value={fmtNum(couples.bookedCouples + couples.resolvedCouples + couples.ghostCouples)}
            hint={`booked ${couples.bookedCouples} · resolved ${couples.resolvedCouples} · ghost ${couples.ghostCouples}`}
          />
          <MetaCard
            label="Channel-scoped"
            value={fmtNum(couples.channelScopedCouples)}
            hint="prospects, often vendor noise"
          />
          <MetaCard
            label="Fragments"
            value={fmtNum(couples.fragmentsTotal)}
            hint={`${fmtNum(couples.fragmentsUnpromoted)} unpromoted`}
          />
          <MetaCard
            label="Promotion rate"
            value={fmtPct(couples.fragmentPromotionRate)}
            hint="fragments bound to a couple"
          />
        </div>

        <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">
          Candidate-match confidence distribution
        </div>
        <div className="overflow-x-auto -mx-6 px-6">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500 uppercase tracking-wide">
              <tr>
                <th className="py-2">State</th>
                <th className="py-2 text-right">High</th>
                <th className="py-2 text-right">Medium</th>
                <th className="py-2 text-right">Low</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-stone-200">
                <td className="py-2 font-medium">Open (awaiting decision)</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.open.high)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.open.medium)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.open.low)}</td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className="py-2 font-medium text-emerald-800">Confirmed</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.confirmed.high)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.confirmed.medium)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.confirmed.low)}</td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className="py-2 font-medium text-rose-800">Rejected</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.rejected.high)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.rejected.medium)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.rejected.low)}</td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className="py-2 font-medium text-stone-700">Deferred</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.deferred.high)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.deferred.medium)}</td>
                <td className="py-2 text-right">{fmtNum(confidenceDistribution.resolved.deferred.low)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-500 mt-3">
          Calibration read: high-tier rejections (top-right) and low-tier
          confirmations (bottom-right) are the two cells that diagnose
          matcher drift. The first means Bloom called something high-
          confidence that you disagreed with; the second means Bloom called
          something low-confidence that you saw as same.
        </p>
      </Section>

      {/* Q29 — top + bottom 20 merges */}
      <Section
        icon={<GitMerge className="w-4 h-4" />}
        title="Merges Bloom performed"
        hint="Q29 — 20 highest-confidence + 20 lowest-confidence"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MergeList
            title="Top 20 — highest confidence"
            emptyMessage="No high-confidence merges recorded yet."
            merges={data.topMerges}
          />
          <MergeList
            title="Bottom 20 — lowest confidence"
            emptyMessage="No low-confidence merges recorded yet."
            merges={data.bottomMerges}
          />
        </div>
        <p className="text-xs text-stone-500 mt-4">
          Each row is one entry in <code>couple_merge_events</code>: the
          two couples Bloom joined, the rule / reason it cited, the
          confidence tier, and whether you or the auto-promoter pulled
          the trigger.
        </p>
      </Section>

      {/* Q30 — completeness */}
      <Section
        icon={<CheckSquare className="w-4 h-4" />}
        title="Record completeness (last 90 days)"
        hint="Q30 — how many couples have a full record vs partial"
      >
        {completeness.totalEvaluated === 0 ? (
          <p className="text-sm text-stone-500">
            No engaged couples in the last {completeness.windowDays} days yet.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
              {completeness.buckets.map((b) => (
                <div
                  key={b.label}
                  className="border border-stone-200 rounded-lg px-4 py-3"
                  title={b.description}
                >
                  <div className="text-xs text-stone-500 uppercase tracking-wide">{b.label}</div>
                  <div className="text-xl text-stone-900 mt-1">{fmtNum(b.count)}</div>
                  <div className="text-[11px] text-stone-500 mt-0.5">
                    {Math.round((b.count / completeness.totalEvaluated) * 100)}% of cohort
                  </div>
                </div>
              ))}
            </div>
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              Per-dimension presence
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <DimensionCard
                label="Wedding date"
                count={completeness.withWeddingDate}
                total={completeness.totalEvaluated}
              />
              <DimensionCard
                label="Primary email"
                count={completeness.withPrimaryEmail}
                total={completeness.totalEvaluated}
              />
              <DimensionCard
                label="Acquisition touch"
                count={completeness.withAcquisitionTouch}
                total={completeness.totalEvaluated}
              />
              <DimensionCard
                label="Venue reply"
                count={completeness.withVenueReply}
                total={completeness.totalEvaluated}
              />
            </div>
            <p className="text-xs text-stone-500 mt-4">
              A Complete record has wedding date, primary email, at least one
              acquisition-channel inbound touch, and at least one venue reply.
              Missing acquisition touch is usually a Tracer re-bind gap;
              missing venue reply is usually a Calendly-only inbound that
              never made it to messageable.
            </p>
          </>
        )}
      </Section>

      {/* Q36 — most confident same + borderline pending */}
      <Section
        icon={<AlertTriangle className="w-4 h-4" />}
        title="Same / different — precision and the borderline"
        hint="Q36 — 5 most confident same + 5 pending borderline"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MergeList
            title="5 Bloom is most confident are the same"
            emptyMessage="No high-confidence same-merges recorded yet."
            merges={data.mostConfidentSame}
          />
          <PendingList
            title="5 borderline pending — could go either way"
            pendings={data.borderlinePending}
          />
        </div>
        <p className="text-xs text-stone-500 mt-4">
          Read the top-5 looking for any pair that should not be merged
          (precision break). Read the pending 5 looking for any pair you
          would resolve immediately (lazy queue). Both are diagnostic
          signals on the matcher's calibration.
        </p>
      </Section>
    </div>
  )
}

function MergeList({
  title,
  emptyMessage,
  merges,
}: {
  title: string
  emptyMessage: string
  merges: IdentityReportMerge[]
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">{title}</div>
      {merges.length === 0 ? (
        <p className="text-sm text-stone-500 italic">{emptyMessage}</p>
      ) : (
        <ol className="space-y-2">
          {merges.map((m) => (
            <li key={m.id} className="border border-stone-200 rounded-md p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${tierBadgeClass(m.confidenceTier)}`}
                >
                  {m.confidenceTier ?? 'unknown'}
                </span>
                <span className="text-xs text-stone-500">{fmtDate(m.occurredAt)}</span>
              </div>
              <div className="text-stone-900">
                {m.primary.label ?? '(unknown primary)'} <span className="text-stone-400">↔</span>{' '}
                {m.secondary.label ?? '(unknown secondary)'}
              </div>
              <div className="text-[11px] text-stone-500 mt-0.5">
                {m.eventType}
                {m.ruleTriggered ? ` · ${m.ruleTriggered}` : ''}
                {m.operatorId ? ' · operator' : ' · auto'}
              </div>
              {m.reason && (
                <div className="text-xs text-stone-600 mt-1 italic">"{m.reason}"</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function PendingList({
  title,
  pendings,
}: {
  title: string
  pendings: IdentityReportPending[]
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">{title}</div>
      {pendings.length === 0 ? (
        <p className="text-sm text-stone-500 italic">
          No medium-tier pending decisions. Check back as the matcher routes
          new uncertain cases.
        </p>
      ) : (
        <ol className="space-y-2">
          {pendings.map((p) => (
            <li key={p.id} className="border border-stone-200 rounded-md p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${tierBadgeClass(p.confidenceTier)}`}
                >
                  {p.confidenceTier ?? 'unknown'}
                </span>
                <span className="text-xs text-stone-500">{fmtDate(p.createdAt)}</span>
              </div>
              <div className="text-stone-900">
                {p.primary.label ?? `(${p.primary.recordType}: ${p.primary.recordId.slice(0, 8)}…)`}{' '}
                <span className="text-stone-400">↔</span>{' '}
                {p.secondary.label ?? `(${p.secondary.recordType}: ${p.secondary.recordId.slice(0, 8)}…)`}
              </div>
              <div className="text-[11px] text-stone-500 mt-0.5">
                {p.primary.recordType} ↔ {p.secondary.recordType}
              </div>
              {p.matcherReason && (
                <div className="text-xs text-stone-600 mt-1 italic">"{p.matcherReason}"</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function DimensionCard({
  label,
  count,
  total,
}: {
  label: string
  count: number
  total: number
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="border border-stone-200 rounded-md px-3 py-2">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-sm text-stone-900 mt-0.5">
        {fmtNum(count)} <span className="text-stone-400">/ {fmtNum(total)}</span>
      </div>
      <div className="text-[11px] text-stone-500 mt-0.5">{pct}%</div>
    </div>
  )
}
