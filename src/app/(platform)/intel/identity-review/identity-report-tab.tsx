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
  ShieldAlert,
  Wrench,
  Check,
} from 'lucide-react'
import type {
  IdentityReport,
  IdentityReportMerge,
  IdentityReportPending,
} from '@/lib/services/identity/identity-report'
import type { SuspectMerge, SuspectClass } from '@/lib/services/identity/suspect-merges'
import type {
  LifecycleAuditReport,
  LifecycleAuditRow,
  DuplicateGroup,
} from '@/lib/services/identity/lifecycle-audit'

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
  const [suspects, setSuspects] = useState<SuspectMerge[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [reportRes, suspectsRes] = await Promise.all([
        fetch('/api/admin/intel/identity-report', { cache: 'no-store' }),
        fetch('/api/admin/intel/suspect-merges', { cache: 'no-store' }),
      ])
      const reportBody: ApiResponse = await reportRes.json()
      if (!reportBody.ok || !reportBody.report) {
        setError(reportBody.error ?? 'Failed to load identity report')
      } else {
        setData(reportBody.report)
      }
      const suspectsBody = (await suspectsRes.json()) as {
        ok: boolean
        suspects?: SuspectMerge[]
      }
      if (suspectsBody.ok && Array.isArray(suspectsBody.suspects)) {
        setSuspects(suspectsBody.suspects)
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
      {/* One-shot maintenance actions */}
      <MaintenancePanel />

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

      {/* Lifecycle audit - drift + duplicate diagnostics */}
      <LifecycleAuditSection />

      {/* Suspect merges - cleanup diagnostic */}
      <Section
        icon={<ShieldAlert className="w-4 h-4" />}
        title="Suspect merges (cleanup queue)"
        hint="Past merges that fail the post-2026-05-20 matcher guards"
      >
        {suspects === null ? (
          <p className="text-sm text-stone-500">
            Loading suspect-merge diagnostic…
          </p>
        ) : suspects.length === 0 ? (
          <p className="text-sm text-stone-500">
            No suspect merges found. The matcher guards are catching everything
            before it lands.
          </p>
        ) : (
          <>
            <p className="text-sm text-stone-700 mb-3">
              Each row below is a couple-merge Bloom performed where the
              evidence looks shaped like a known false-positive pattern. Read
              the names: if the two couples are clearly different people, the
              merge needs reversing. Use the existing review queue's reject
              action (or the operator-merge endpoint) to walk it back.
            </p>
            <div className="space-y-2">
              {suspects.map((s) => (
                <SuspectMergeCard key={s.mergeEventId} suspect={s} />
              ))}
            </div>
            <p className="text-xs text-stone-500 mt-3">
              The diagnostic flags three signal classes:{' '}
              <strong>substring_name</strong> (one couple&apos;s first or last
              name is a strict substring of the other&apos;s — the
              Makayla/Kayla shape),{' '}
              <strong>levenshtein_reason</strong> (merge was performed under
              the legacy Levenshtein-2 rule which the post-2026-05-20 guards
              now reject), and <strong>low_tier_name_only</strong> (low-
              confidence merges keyed on name signals without an email or
              phone corroborator).
            </p>
          </>
        )}
      </Section>
    </div>
  )
}

function SuspectMergeCard({ suspect }: { suspect: SuspectMerge }) {
  const signalLabel: Record<SuspectClass, string> = {
    substring_name: 'substring',
    levenshtein_reason: 'legacy levenshtein',
    low_tier_name_only: 'low-tier name only',
  }
  const signalClass: Record<SuspectClass, string> = {
    substring_name: 'bg-rose-100 text-rose-800 border-rose-200',
    levenshtein_reason: 'bg-amber-100 text-amber-800 border-amber-200',
    low_tier_name_only: 'bg-stone-100 text-stone-700 border-stone-200',
  }
  return (
    <div className="border border-stone-200 rounded-md p-3 text-sm">
      <div className="flex items-center justify-between mb-1">
        <div className="flex flex-wrap items-center gap-1">
          {suspect.signals.map((sig) => (
            <span
              key={sig}
              className={`inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${signalClass[sig]}`}
            >
              {signalLabel[sig]}
            </span>
          ))}
          <span
            className={`inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${tierBadgeClass(suspect.confidenceTier)}`}
          >
            {suspect.confidenceTier ?? 'unknown'}
          </span>
        </div>
        <span className="text-xs text-stone-500">
          {fmtDate(suspect.occurredAt)}
        </span>
      </div>
      <div className="text-stone-900">
        {suspect.primaryFirstName ?? suspect.primaryLabel ?? '(unknown primary)'}{' '}
        {suspect.primaryLastName ? suspect.primaryLastName : ''}{' '}
        <span className="text-stone-400">↔</span>{' '}
        {suspect.secondaryFirstName ?? suspect.secondaryLabel ?? '(unknown secondary)'}{' '}
        {suspect.secondaryLastName ? suspect.secondaryLastName : ''}
      </div>
      {suspect.reason && (
        <div className="text-xs text-stone-600 mt-1 italic">
          &quot;{suspect.reason}&quot;
        </div>
      )}
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

// ---------------------------------------------------------------------------
// MaintenancePanel - one-shot operator actions for the post-T8.2 backfills.
// Authenticated browser fetch sends the session cookie automatically, so the
// /api/admin/* endpoints' getPlatformAuth resolves the venue without a curl
// wrestle. Each button calls its endpoint, shows the resulting counts.
// ---------------------------------------------------------------------------

type ActionState = 'idle' | 'running' | 'done' | 'error'

function MaintenancePanel() {
  return (
    <section className="bg-white border border-stone-200 rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-stone-200 flex items-center gap-2">
        <Wrench className="w-4 h-4 text-stone-500" />
        <h2 className="text-base font-semibold text-stone-900">
          Maintenance actions
        </h2>
        <span className="text-xs text-stone-500 ml-auto">
          One-shot backfills. Safe to re-run; second runs no-op.
        </span>
      </div>
      <div className="px-6 py-4 space-y-3">
        <ActionRow
          title="Tracer rebind"
          description="Backfills touchpoints for mirror-backfilled couples that have a wedding link but zero touchpoints. Closes the amber honesty card on /intel/cohort."
          endpoint="/api/admin/identity/tracer-rebind"
          body={{ coupleLimit: 1000 }}
          renderResult={(r: { couplesScanned?: number; couplesUpdated?: number; touchpointsInserted?: number }) =>
            `Scanned ${r.couplesScanned ?? 0} couples; backfilled ${r.couplesUpdated ?? 0} of them (${r.touchpointsInserted ?? 0} new touchpoints).`
          }
        />
        <ActionRow
          title="Calendly attendance sweep"
          description="Fires tour_attended for past-scheduled Calendly bookings that lack a terminal outcome. Populates the Toured stage on cohort funnel + Q10 weather x no-show."
          endpoint="/api/admin/calendly/attendance-sweep"
          body={{ bookingLimit: 2000 }}
          renderResult={(r: { bookingsScanned?: number; attendedInserted?: number; cancelledSkipped?: number }) =>
            `Scanned ${r.bookingsScanned ?? 0} bookings; ${r.attendedInserted ?? 0} marked attended; ${r.cancelledSkipped ?? 0} already had a cancellation.`
          }
        />
        <ActionRow
          title="Post-wedding sweep"
          description="Flips couples whose lifecycle_state is 'booked' AND wedding_date < today to 'completed'. Keeps surfaces honest about which bookings are still ahead vs already done."
          endpoint="/api/admin/identity/post-wedding-sweep"
          body={{ limit: 2000 }}
          renderResult={(r: { bookedScanned?: number; completedTransitioned?: number }) =>
            `Scanned ${r.bookedScanned ?? 0} booked couples with past wedding dates; transitioned ${r.completedTransitioned ?? 0} to completed.`
          }
        />
      </div>
    </section>
  )
}

function ActionRow<R extends Record<string, unknown>>({
  title,
  description,
  endpoint,
  body,
  renderResult,
}: {
  title: string
  description: string
  endpoint: string
  body: Record<string, unknown>
  renderResult: (r: R) => string
}) {
  const [state, setState] = useState<ActionState>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const run = async () => {
    setState('running')
    setMessage(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!res.ok) {
        const errMsg =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as Record<string, unknown>).error)
            : `HTTP ${res.status}`
        setMessage(errMsg)
        setState('error')
        return
      }
      if (parsed && typeof parsed === 'object') {
        setMessage(renderResult(parsed as R))
      } else {
        setMessage('Completed.')
      }
      setState('done')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  const busy = state === 'running'

  return (
    <div className="border border-stone-200 rounded-md p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-stone-900">{title}</div>
          <p className="text-xs text-stone-600 mt-0.5">{description}</p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            busy
              ? 'bg-stone-300 text-white cursor-wait'
              : state === 'done'
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-stone-900 text-white hover:bg-stone-800'
          }`}
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {state === 'done' && !busy && <Check className="w-3 h-3" />}
          {busy ? 'Running…' : state === 'done' ? 'Run again' : 'Run'}
        </button>
      </div>
      {message && (
        <div
          className={`mt-2 text-xs ${
            state === 'error' ? 'text-rose-700' : 'text-stone-700'
          }`}
        >
          {message}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LifecycleAuditSection - drift + duplicate diagnostics on the spine.
// Loads lazily on user-click (the underlying scan walks every couple +
// every progression event for the venue; not free).
// ---------------------------------------------------------------------------

function LifecycleAuditSection() {
  const [data, setData] = useState<LifecycleAuditReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Record<string, string>>({})

  const run = async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const res = await fetch('/api/admin/intel/lifecycle-audit', {
        cache: 'no-store',
      })
      const body = (await res.json()) as {
        ok: boolean
        report?: LifecycleAuditReport
        error?: string
      }
      if (!body.ok || !body.report) {
        setError(body.error ?? 'Failed to load audit')
      } else {
        setData(body.report)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const applyRow = async (row: LifecycleAuditRow) => {
    if (!row.expectedState) return
    setApplied((m) => ({ ...m, [row.coupleId]: 'applying' }))
    try {
      const res = await fetch('/api/admin/intel/lifecycle-audit/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          coupleId: row.coupleId,
          newState: row.expectedState,
        }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) {
        setApplied((m) => ({
          ...m,
          [row.coupleId]: `failed: ${body.error ?? res.statusText}`,
        }))
      } else {
        setApplied((m) => ({ ...m, [row.coupleId]: 'applied' }))
      }
    } catch (err) {
      setApplied((m) => ({
        ...m,
        [row.coupleId]: `failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }

  return (
    <section className="bg-white border border-stone-200 rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-stone-200 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-stone-500" />
        <h2 className="text-base font-semibold text-stone-900">
          Lifecycle audit
        </h2>
        <span className="text-xs text-stone-500 ml-auto">
          Diff couples whose lifecycle disagrees with their spine signals +
          surface likely-duplicate couples the cascade missed.
        </span>
      </div>
      <div className="px-6 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              loading
                ? 'bg-stone-300 text-white cursor-wait'
                : 'bg-stone-900 text-white hover:bg-stone-800'
            }`}
          >
            {loading && <Loader2 className="w-3 h-3 animate-spin" />}
            {loading ? 'Scanning…' : data ? 'Re-run audit' : 'Run audit'}
          </button>
          {data && (
            <div className="text-xs text-stone-600">
              {data.meta.couplesScanned.toLocaleString()} couples scanned ·{' '}
              {data.meta.driftCount.toLocaleString()} drift ·{' '}
              {data.meta.duplicateGroupCount.toLocaleString()} duplicate
              groups ({data.meta.duplicateCoupleCount.toLocaleString()} couples)
            </div>
          )}
        </div>

        {error && (
          <div className="text-xs text-rose-700 px-3 py-2 rounded bg-rose-50 border border-rose-200">
            {error}
          </div>
        )}

        {data && data.drift.length > 0 && (
          <DriftSection drift={data.drift} applied={applied} setApplied={setApplied} applyRow={applyRow} />
        )}

        {data && data.duplicates.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              Likely duplicate couples ({data.duplicates.length} groups)
            </div>
            <p className="text-xs text-stone-600 mb-2">
              Couples whose partner1 first+last names AND partner2 first name
              match within the venue. The cascade missed these because
              identifiers (email / phone) diverge on the records. Operator
              merges via the existing /api/admin/identity/resolve action.
            </p>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {data.duplicates.slice(0, 30).map((g) => (
                <DuplicateGroupCard key={g.key} group={g} />
              ))}
            </div>
            {data.duplicates.length > 30 && (
              <p className="text-xs text-stone-500 mt-2">
                Showing first 30 of {data.duplicates.length.toLocaleString()}.
              </p>
            )}
          </div>
        )}

        {data && data.drift.length === 0 && data.duplicates.length === 0 && (
          <p className="text-sm text-stone-500 italic">
            Clean. No lifecycle drift, no duplicate-couple candidates.
          </p>
        )}
      </div>
    </section>
  )
}

function DriftRow({
  row,
  appliedStatus,
  onApply,
}: {
  row: LifecycleAuditRow
  appliedStatus: string | undefined
  onApply: () => void
}) {
  const isApplied = appliedStatus === 'applied'
  const isApplying = appliedStatus === 'applying'
  const isFailed = appliedStatus?.startsWith('failed')
  return (
    <div className="border border-stone-200 rounded-md p-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-stone-900">
            {row.primaryName ?? row.primaryEmail ?? '(unknown)'}
          </div>
          <div className="text-xs text-stone-600 mt-0.5">
            <span className="font-mono text-rose-700">
              {row.currentState ?? '(null)'}
            </span>{' '}
            →{' '}
            <span className="font-mono text-emerald-700">
              {row.expectedState ?? '(null)'}
            </span>
          </div>
          <div className="text-[11px] text-stone-500 mt-0.5 italic">
            {row.rationale}
          </div>
          {appliedStatus && (
            <div
              className={`text-[11px] mt-1 ${isApplied ? 'text-emerald-700' : isFailed ? 'text-rose-700' : 'text-stone-500'}`}
            >
              {appliedStatus}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onApply}
          disabled={isApplied || isApplying}
          className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium ${
            isApplied
              ? 'bg-emerald-100 text-emerald-700'
              : isApplying
                ? 'bg-stone-300 text-white'
                : 'bg-stone-900 text-white hover:bg-stone-800'
          }`}
        >
          {isApplied ? 'Applied' : isApplying ? '...' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  return (
    <div className="border border-stone-200 rounded-md p-3 text-sm">
      <div className="text-[11px] text-stone-500 mb-1">
        {group.couples.length} likely-duplicate records for this couple
      </div>
      <ul className="space-y-1.5">
        {group.couples.map((c) => (
          <li
            key={c.coupleId}
            className="flex items-center gap-2 text-stone-800"
          >
            <a
              href={`/intel/couples/${c.coupleId}`}
              className="font-medium hover:underline"
            >
              {c.primaryName ?? '(no name)'}
              {c.partnerName ? ` & ${c.partnerName}` : ''}
            </a>
            <span className="text-xs text-stone-500">
              {c.primaryEmail ?? 'no email'}
            </span>
            <span
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                c.lifecycleState === 'booked'
                  ? 'bg-sky-100 text-sky-800 border-sky-200'
                  : c.lifecycleState === 'ghost'
                    ? 'bg-stone-100 text-stone-500 border-stone-200'
                    : 'bg-emerald-100 text-emerald-800 border-emerald-200'
              }`}
            >
              {c.lifecycleState ?? 'unknown'}
            </span>
            {c.weddingDate && (
              <span className="text-[11px] text-stone-500 ml-auto">
                wed {c.weddingDate}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DriftSection - groups drift by transition + offers bulk-apply per group.
// The first live run (2026-05-20) produced 667 drift rows; clicking
// Apply 667 times is not the operator experience. Grouping by
// (current -> expected) gives one-click bulk application of the
// homogeneous corrections.
// ---------------------------------------------------------------------------

function DriftSection({
  drift,
  applied,
  setApplied,
  applyRow,
}: {
  drift: LifecycleAuditRow[]
  applied: Record<string, string>
  setApplied: React.Dispatch<React.SetStateAction<Record<string, string>>>
  applyRow: (row: LifecycleAuditRow) => Promise<void>
}) {
  // Group by (current -> expected) transition.
  type Group = {
    current: string
    expected: string
    rows: LifecycleAuditRow[]
  }
  const groups: Group[] = []
  const groupKey = (r: LifecycleAuditRow) =>
    `${r.currentState ?? '(null)'}->${r.expectedState ?? '(null)'}`
  const byKey = new Map<string, Group>()
  for (const row of drift) {
    const k = groupKey(row)
    let g = byKey.get(k)
    if (!g) {
      g = {
        current: row.currentState ?? '(null)',
        expected: row.expectedState ?? '(null)',
        rows: [],
      }
      byKey.set(k, g)
      groups.push(g)
    }
    g.rows.push(row)
  }
  // Order: terminal-positive corrections first (resolved->ghost,
  // booked->completed, channel_scoped->resolved), then lower-stakes
  // ones (resolved->channel_scoped).
  const transitionRank = (current: string, expected: string): number => {
    const e = expected
    if (e === 'booked' || e === 'completed') return 0
    if (e === 'ghost') return 1
    if (e === 'resolved') return 2
    if (e === 'channel_scoped') return 3
    return 4
  }
  groups.sort((a, b) => transitionRank(a.current, a.expected) - transitionRank(b.current, b.expected))

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">
        Lifecycle drift ({drift.length})
      </div>
      <div className="space-y-3">
        {groups.map((g) => (
          <DriftGroupCard
            key={`${g.current}->${g.expected}`}
            group={g}
            applied={applied}
            setApplied={setApplied}
            applyRow={applyRow}
          />
        ))}
      </div>
    </div>
  )
}

function DriftGroupCard({
  group,
  applied,
  setApplied,
  applyRow,
}: {
  group: {
    current: string
    expected: string
    rows: LifecycleAuditRow[]
  }
  applied: Record<string, string>
  setApplied: React.Dispatch<React.SetStateAction<Record<string, string>>>
  applyRow: (row: LifecycleAuditRow) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [bulkState, setBulkState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)

  const unappliedRows = group.rows.filter((r) => !applied[r.coupleId])

  const bulkApply = async () => {
    if (unappliedRows.length === 0) return
    setBulkState('running')
    setBulkMessage(null)
    // Chunk to 500 max per bulk-apply call.
    const CHUNK = 500
    let totalUpdated = 0
    let totalSkipped = 0
    try {
      for (let i = 0; i < unappliedRows.length; i += CHUNK) {
        const slice = unappliedRows.slice(i, i + CHUNK)
        const res = await fetch('/api/admin/intel/lifecycle-audit/bulk-apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            coupleIds: slice.map((r) => r.coupleId),
            newState: group.expected,
          }),
        })
        const body = (await res.json()) as {
          ok: boolean
          updated?: number
          skipped?: number
          error?: string
        }
        if (!res.ok || !body.ok) {
          setBulkState('error')
          setBulkMessage(body.error ?? `HTTP ${res.status}`)
          return
        }
        totalUpdated += body.updated ?? 0
        totalSkipped += body.skipped ?? 0
        // Mark each in-flight row applied so the per-row state stays
        // consistent with the bulk run.
        setApplied((m) => {
          const next = { ...m }
          for (const r of slice) next[r.coupleId] = 'applied'
          return next
        })
      }
      setBulkState('done')
      setBulkMessage(
        `Updated ${totalUpdated}; skipped ${totalSkipped} (not in your venue or already done).`,
      )
    } catch (err) {
      setBulkState('error')
      setBulkMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const busy = bulkState === 'running'

  return (
    <div className="border border-stone-200 rounded-md">
      <div className="px-3 py-2 border-b border-stone-200 bg-stone-50 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-stone-600 hover:text-stone-900"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div className="flex-1 text-sm">
          <span className="font-mono text-rose-700">{group.current}</span>
          <span className="text-stone-400"> → </span>
          <span className="font-mono text-emerald-700">{group.expected}</span>
          <span className="text-stone-500 ml-2">
            ({group.rows.length} couple{group.rows.length === 1 ? '' : 's'},{' '}
            {unappliedRows.length} unapplied)
          </span>
        </div>
        <button
          type="button"
          onClick={bulkApply}
          disabled={busy || unappliedRows.length === 0}
          className={`shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium ${
            busy
              ? 'bg-stone-300 text-white cursor-wait'
              : unappliedRows.length === 0
                ? 'bg-stone-200 text-stone-500'
                : 'bg-stone-900 text-white hover:bg-stone-800'
          }`}
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {busy
            ? 'Applying…'
            : unappliedRows.length === 0
              ? 'All applied'
              : `Apply all ${unappliedRows.length}`}
        </button>
      </div>
      {bulkMessage && (
        <div
          className={`px-3 py-1.5 text-xs ${bulkState === 'error' ? 'text-rose-700' : 'text-stone-600'}`}
        >
          {bulkMessage}
        </div>
      )}
      {expanded && (
        <div className="px-3 py-2 space-y-2 max-h-96 overflow-y-auto">
          {group.rows.slice(0, 200).map((row) => (
            <DriftRow
              key={row.coupleId}
              row={row}
              appliedStatus={applied[row.coupleId]}
              onApply={() => applyRow(row)}
            />
          ))}
          {group.rows.length > 200 && (
            <p className="text-xs text-stone-500">
              Showing first 200 of {group.rows.length.toLocaleString()}; bulk
              apply hits them all.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
